import * as vscode from 'vscode';
import * as path from 'node:path';
import { Change, ReviewComment, ReviewSession, ReviewStore, Side, captureAnchor, locateAnchor,
  makeComment, newSession, hash, linesOf, LocatedAnchor } from './model';
import { baselineChoices, listChanges, readBase, relativeFile, resolveCommit, runGit } from './git';
import { CommentExport, exportData, markdownReview } from './export';
import { FilesAction, FilesState, ReviewFile, ReviewFilesView } from './filesView';
import { BASE_SCHEME as SCHEME, FILES_VIEW_ID, NAMESPACE } from './identifiers';

const STORE_KEY = 'reviews.v1';
interface VirtualResource { sessionId: string; path: string; empty?: boolean; role?: 'missing-current' }
interface Target { path: string; basePath: string; side: Side }
interface EditableComment extends vscode.Comment { reviewId: string }
type Node = { type: 'file'; change: Change } | { type: 'comment'; comment: ReviewComment };

export class ReviewExtension implements vscode.Disposable {
  private store: ReviewStore;
  private disposables: vscode.Disposable[] = [];
  readonly controller: vscode.CommentController;
  private filesView: ReviewFilesView;
  private status: vscode.StatusBarItem;
  private threads = new Map<string, vscode.CommentThread>();
  private threadIds = new WeakMap<vscode.CommentThread, string>();
  private locations = new Map<string, LocatedAnchor>();
  private changes: Change[] = [];
  private baseCache = new Map<string, Promise<string>>();
  private saveQueue: Promise<void> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private refreshTask?: Promise<void>;
  private refreshQueued = false;
  private disposed = false;
  get session(): ReviewSession | undefined { return this.store.sessions.find(s => s.id === this.store.activeId); }
  get changedFiles(): readonly Change[] { return this.changes; }
  private get git(): string { return vscode.workspace.getConfiguration(NAMESPACE).get('gitPath', 'git'); }
  private get contextLines(): number { return vscode.workspace.getConfiguration(NAMESPACE).get('contextLines', 3); }

  constructor(private readonly context: vscode.ExtensionContext) {
    this.store = context.workspaceState.get<ReviewStore>(STORE_KEY, { version: 1, sessions: [] });
    this.controller = vscode.comments.createCommentController(NAMESPACE, 'Local Diff Review');
    this.controller.options = { prompt: 'Write a local review comment', placeHolder: 'Describe the requested change…' };
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: document => this.targetForUri(document.uri)
        ? [new vscode.Range(0, 0, document.lineCount - 1, document.lineAt(document.lineCount - 1).text.length)] : []
    };
    this.filesView = new ReviewFilesView(file => this.fileUri(file), action => this.handleFilesAction(action));
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
    this.status.command = FILES_VIEW_ID + '.focus';
    this.disposables.push(this.controller, this.filesView, this.status,
      vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
        provideTextDocumentContent: uri => this.provideBase(uri)
      }));
    this.command('start', (ref?: unknown, root?: vscode.Uri) =>
      this.start(typeof ref === 'string' ? ref : undefined, root));
    this.command('resume', () => this.resume());
    this.command('refresh', () => this.refresh());
    this.command('fileAction', (action?: FilesAction) => action && this.handleFilesAction(action));
    this.command('openDiff', (item: Node | Change | string) => this.openDiff(item));
    this.command('addComment', () => this.addComment());
    this.command('reply', (reply: vscode.CommentReply) => this.reply(reply));
    this.command('editComment', (item: unknown) => this.editComment(item));
    this.command('saveEdit', (item: EditableComment) => this.saveEdit(item));
    this.command('cancelEdit', (item: EditableComment) => this.cancelEdit(item));
    this.command('discardDraft', (input: vscode.CommentReply | vscode.CommentThread) =>
      this.discard(input && 'thread' in input ? input.thread : input));
    this.command('discard', (item: unknown) => this.discard(item));
    this.command('toggleResolved', (item: unknown) => this.toggleResolved(item));
    this.command('reanchor', (item: unknown) => this.reanchor(item));
    this.command('copy', () => this.copyReview());
    this.command('export', () => this.exportReview());
    this.disposables.push(vscode.workspace.onDidChangeTextDocument(e => {
      if (e.contentChanges.length && this.targetForUri(e.document.uri)?.side === 'current') { this.scheduleRefresh(); }
    }), vscode.workspace.onDidSaveTextDocument(document => {
      if (this.targetForUri(document.uri)?.side === 'current') { this.scheduleRefresh(); }
    }));
  }

  async initialize(): Promise<void> { this.publishReview(); await this.refresh(); }

  get fileList(): FilesState {
    const session = this.session;
    if (!session) { return { files: [] }; }
    const reviewed = new Set(session.reviewedFiles ?? []);
    const files = new Map<string, ReviewFile>();
    for (const change of this.changes) {
      files.set(change.path, { path: change.path, status: change.status, reviewed: reviewed.has(change.path), comments: [] });
    }
    for (const comment of session.comments) {
      let file = files.get(comment.path);
      if (!file) {
        file = { path: comment.path, status: '', reviewed: reviewed.has(comment.path), comments: [] };
        files.set(comment.path, file);
      }
      const location = this.locations.get(comment.id);
      file.comments.push({ id: comment.id, body: comment.body, side: comment.side,
        line: (location?.start ?? comment.anchor.start) + 1, location: location?.status ?? 'current', resolved: comment.resolved });
    }
    return { sessionId: session.id, baseLabel: session.baseLabel,
      files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)) };
  }
  private publishReview(): void {
    this.filesView.update(this.fileList);
    const session = this.session;
    if (!session) { this.status.hide(); return; }
    this.status.text = '$(comment-discussion) Review: ' + session.comments.filter(c => !c.resolved).length;
    this.status.tooltip = session.baseLabel + ' → workspace';
    this.status.show();
  }
  private async handleFilesAction(action: FilesAction): Promise<void> {
    if (action.type === 'start') { await this.start(); return; }
    if (action.type === 'resume') { await this.resume(); return; }
    if (!this.session || action.sessionId !== this.session.id) { this.publishReview(); return; }
    if (action.type === 'setReviewed') { await this.setReviewed(action.path, action.reviewed); return; }
    if (action.type === 'openFile') {
      if (this.fileList.files.some(file => file.path === action.path)) { await this.openDiff(action.path); }
      return;
    }
    if (!('id' in action)) { return; }
    const comment = this.session.comments.find(note => note.id === action.id);
    if (!comment) { return; }
    switch (action.type) {
      case 'openComment': await this.openDiff({ type: 'comment', comment }); break;
      case 'editComment':
        await this.openDiff({ type: 'comment', comment });
        await this.editComment(comment);
        break;
      case 'toggleResolved': await this.toggleResolved(comment); break;
      case 'discardComment': await this.discard(comment); break;
      case 'reanchorComment': await this.reanchor(comment); break;
    }
  }
  async setReviewed(file: string, reviewed: boolean): Promise<void> {
    const session = this.session;
    if (!session || !(this.changes.some(entry => entry.path === file) || session.comments.some(note => note.path === file))) {
      throw new Error('File is not in the active review.');
    }
    const paths = new Set(session.reviewedFiles ?? []);
    if (reviewed) { paths.add(file); } else { paths.delete(file); }
    session.reviewedFiles = [...paths].sort();
    this.filesView.setReviewed(session.id, file, reviewed);
    await this.save();
  }
  private command(name: string, action: (...args: any[]) => unknown): void {
    this.disposables.push(vscode.commands.registerCommand(NAMESPACE + '.' + name, async (...args: any[]) => {
      try { return await action(...args); }
      catch (error) { void vscode.window.showErrorMessage('Local Diff Review: ' + errorMessage(error)); }
    }));
  }
  private async save(): Promise<void> {
    const snapshot = JSON.parse(JSON.stringify(this.store)) as ReviewStore;
    const next = this.saveQueue.then(() => this.context.workspaceState.update(STORE_KEY, snapshot));
    this.saveQueue = next.catch(() => {});
    await next;
  }
  private rootUri(session = this.session): vscode.Uri {
    if (!session) { throw new Error('Start a review first.'); }
    return vscode.Uri.parse(session.rootUri);
  }
  fileUri(file: string, session = this.session): vscode.Uri {
    return vscode.Uri.joinPath(this.rootUri(session), file);
  }
  baseUri(file: string, empty = false, session = this.session, missingCurrent = false): vscode.Uri {
    if (!session) { throw new Error('Start a review first.'); }
    const data: VirtualResource = { sessionId: session.id, path: file, empty,
      ...(missingCurrent ? { role: 'missing-current' as const } : {}) };
    return this.fileUri(file, session).with({ scheme: SCHEME, query: JSON.stringify(data), fragment: '' });
  }
  private decodeVirtual(uri: vscode.Uri): { data: VirtualResource; session: ReviewSession } | undefined {
    if (uri.scheme !== SCHEME) { return undefined; }
    try {
      const data = JSON.parse(uri.query) as VirtualResource;
      const session = this.store.sessions.find(s => s.id === data.sessionId);
      if (session && typeof data.path === 'string' && relativeFile(session.rootPath, path.resolve(session.rootPath, data.path))) {
        return { data, session };
      }
    } catch {}
    return undefined;
  }
  private async provideBase(uri: vscode.Uri): Promise<string> {
    const resource = this.decodeVirtual(uri);
    if (!resource) { throw new Error('This baseline is not part of a saved review.'); }
    if (resource.data.empty) { return ''; }
    return this.baseContent(resource.data.path, resource.session);
  }
  private baseContent(file: string, session = this.session): Promise<string> {
    if (!session) { return Promise.reject(new Error('Start a review first.')); }
    const key = session.id + ':' + file;
    let promise = this.baseCache.get(key);
    if (!promise) {
      promise = readBase(session.rootPath, session.baseSha, file, this.git);
      this.baseCache.set(key, promise);
      promise.catch(() => this.baseCache.delete(key));
      if (this.baseCache.size > 128) { this.baseCache.delete(this.baseCache.keys().next().value!); }
    }
    return promise;
  }
  private targetForUri(uri: vscode.Uri): Target | undefined {
    const session = this.session;
    if (!session) { return undefined; }
    if (uri.scheme === SCHEME) {
      const resource = this.decodeVirtual(uri);
      if (!resource || resource.session.id !== session.id || resource.data.role || resource.data.empty) { return undefined; }
      const change = this.changes.find(c => c.basePath === resource.data.path);
      return { path: change?.path ?? resource.data.path, basePath: resource.data.path, side: 'base' };
    }
    const root = this.rootUri();
    if (uri.scheme !== root.scheme || uri.authority !== root.authority) { return undefined; }
    const file = relativeFile(session.rootPath, uri.fsPath);
    if (!file || file === '.git' || file.startsWith('.git/')) { return undefined; }
    const change = this.changes.find(c => c.path === file);
    return { path: file, basePath: change?.basePath ?? file, side: 'current' };
  }
  private async chooseRoot(input?: vscode.Uri): Promise<vscode.Uri | undefined> {
    const roots: { label: string; uri: vscode.Uri }[] = [];
    const candidates = input ? [input] : [
      ...(vscode.window.activeTextEditor ? [vscode.window.activeTextEditor.document.uri] : []),
      ...(vscode.workspace.workspaceFolders ?? []).map(f => f.uri)
    ];
    for (const candidate of candidates) {
      if (candidate.scheme !== 'file' && candidate.scheme !== 'vscode-remote') { continue; }
      const folder = input || vscode.workspace.workspaceFolders?.some(f => f.uri.toString() === candidate.toString())
        ? candidate.fsPath : path.dirname(candidate.fsPath);
      try {
        const root = (await runGit(folder, ['rev-parse', '--show-toplevel'], this.git)).trim();
        const uri = candidate.scheme === 'file' ? vscode.Uri.file(root) : candidate.with({ path: root, query: '', fragment: '' });
        if (!roots.some(r => r.uri.toString() === uri.toString())) { roots.push({ label: path.basename(root), uri }); }
      } catch {}
    }
    if (!roots.length) { throw new Error('Open a folder containing a Git repository with at least one commit.'); }
    if (roots.length === 1) { return roots[0].uri; }
    return (await vscode.window.showQuickPick(roots.map(r => ({ ...r, description: r.uri.fsPath })),
      { title: 'Choose repository' }))?.uri;
  }
  async start(ref?: string, inputRoot?: vscode.Uri): Promise<void> {
    const root = await this.chooseRoot(inputRoot);
    if (!root) { return; }
    let label = ref;
    if (!ref) {
      const choices = await baselineChoices(root.fsPath, this.git);
      const selection = await vscode.window.showQuickPick([
        { label: 'Enter ref / commit SHA…', ref: '', description: 'Also supports HEAD~N and merge-base SHA' }, ...choices
      ], { title: 'Select baseline → current workspace', matchOnDescription: true });
      if (!selection) { return; }
      ref = selection.ref || await vscode.window.showInputBox({ title: 'Baseline ref or commit SHA', value: 'HEAD',
        prompt: 'The resolved commit is pinned for this review.' });
      label = selection.ref ? selection.label : ref;
    }
    if (!ref?.trim()) { return; }
    const [baseSha, headAtStart] = await Promise.all([
      resolveCommit(root.fsPath, ref.trim(), this.git), resolveCommit(root.fsPath, 'HEAD', this.git)
    ]);
    const existing = this.store.sessions.find(s => s.rootUri === root.toString() && s.baseSha === baseSha);
    const session = existing ?? newSession({ rootUri: root.toString(), rootPath: root.fsPath, baseSha,
      baseLabel: label ?? ref, headAtStart });
    if (!existing) { this.store.sessions.push(session); }
    this.store.activeId = session.id;
    ++this.generation;
    this.disposeThreads();
    this.changes = [];
    this.publishReview();
    await this.save();
    await this.refresh();
    await vscode.commands.executeCommand(FILES_VIEW_ID + '.focus');
  }
  async resume(): Promise<void> {
    if (!this.store.sessions.length) { void vscode.window.showInformationMessage('No saved reviews. Start a review first.'); return; }
    const selection = await vscode.window.showQuickPick(this.store.sessions.map(s => ({
      label: s.baseLabel + ' · ' + s.baseSha.slice(0, 8),
      description: path.basename(s.rootPath) + ' · ' + s.comments.filter(c => !c.resolved).length + ' open comments',
      detail: s.createdAt, session: s
    })), { title: 'Resume local review' });
    if (!selection) { return; }
    this.store.activeId = selection.session.id;
    ++this.generation;
    this.disposeThreads();
    this.changes = [];
    this.publishReview();
    await this.save();
    await this.refresh();
  }
  private scheduleRefresh(): void {
    if (!this.session || this.disposed) { return; }
    if (this.timer) { clearTimeout(this.timer); }
    this.timer = setTimeout(() => { void this.refresh().catch(e => {
      void vscode.window.showErrorMessage('Local Diff Review: ' + errorMessage(e));
    }); }, 350);
  }
  async refresh(): Promise<void> {
    ++this.generation;
    this.refreshQueued = true;
    if (!this.refreshTask) {
      this.refreshTask = this.drainRefreshes().finally(() => { this.refreshTask = undefined; });
    }
    await this.refreshTask;
  }
  private async drainRefreshes(): Promise<void> {
    while (this.refreshQueued && !this.disposed) {
      this.refreshQueued = false;
      try { await this.refreshNow(this.generation); }
      catch (error) { if (!this.refreshQueued) { throw error; } }
    }
  }
  private async refreshNow(generation: number): Promise<void> {
    const session = this.session;
    await vscode.commands.executeCommand('setContext', NAMESPACE + '.active', Boolean(session));
    if (generation !== this.generation || this.disposed) { return; }
    if (!session) { this.status.hide(); return; }
    const changes = await listChanges(session.rootPath, session.baseSha, this.git);
    if (generation !== this.generation || this.disposed) { return; }
    for (const document of vscode.workspace.textDocuments) {
      const target = this.targetForUri(document.uri);
      if (!document.isDirty || !target || target.side !== 'current' || changes.some(c => c.path === target.path)) { continue; }
      let base: string;
      try { base = await this.baseContent(target.path, session); } catch { base = ''; }
      if (document.getText() !== base) { changes.push({ path: target.path, basePath: target.path, status: 'M' }); }
    }
    if (generation !== this.generation || this.disposed) { return; }
    this.changes = changes.sort((a, b) => a.path.localeCompare(b.path));
    // Relocation uses immutable excerpts, never a guessed nearest matching line.
    for (const comment of session.comments) {
      const anchor = comment.anchor;
      let location: LocatedAnchor;
      try {
        const source = await this.sourceFor(comment, session);
        location = locateAnchor(anchor, source);
      }
      catch { location = { start: comment.anchor.start, end: comment.anchor.end, status: 'outdated' }; }
      if (generation !== this.generation || this.disposed) { return; }
      if (!session.comments.includes(comment) || comment.anchor !== anchor) { continue; }
      this.locations.set(comment.id, location);
      this.syncThread(comment, location);
    }
    this.publishReview();
  }
  private async sourceFor(comment: ReviewComment, session = this.session): Promise<string> {
    if (comment.side === 'base') { return this.baseContent(comment.basePath, session); }
    const uri = this.fileUri(comment.path, session);
    const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
    if (open) { return open.getText(); }
    const bytes = await vscode.workspace.fs.readFile(uri);
    if (bytes.includes(0)) { throw new Error('Binary files cannot have text comments.'); }
    return Buffer.from(bytes).toString('utf8');
  }
  private noteUri(comment: ReviewComment): vscode.Uri {
    return comment.side === 'base' ? this.baseUri(comment.basePath) : this.fileUri(comment.path);
  }
  private asRange(range: { start: number; end: number }, endCharacter = 0): vscode.Range {
    return new vscode.Range(range.start, 0, range.end, endCharacter);
  }
  private inclusiveEndLine(range: vscode.Range): number {
    return range.end.line > range.start.line && range.end.character === 0 ? range.end.line - 1 : range.end.line;
  }
  private previewComment(comment: ReviewComment): EditableComment {
    return { body: comment.body, mode: vscode.CommentMode.Preview,
      author: { name: 'Local review' }, timestamp: new Date(comment.createdAt), contextValue: 'saved',
      reviewId: comment.id };
  }
  private syncThread(comment: ReviewComment, location: LocatedAnchor): void {
    let thread = this.threads.get(comment.id);
    if (location.status === 'outdated' || location.status === 'ambiguous') {
      if (thread) { thread.dispose(); this.threads.delete(comment.id); }
      return;
    }
    if (!thread) {
      thread = this.controller.createCommentThread(this.noteUri(comment),
        this.asRange(location, comment.anchor.lines.at(-1)?.length ?? 0), [this.previewComment(comment)]);
      this.threads.set(comment.id, thread);
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    } else {
      // Keep the same comment object through saves and refreshes so the editor does not redraw it.
      const rendered = thread.comments[0] as EditableComment | undefined;
      if (rendered?.mode !== vscode.CommentMode.Editing) {
        if (rendered?.reviewId === comment.id) {
          if (rendered.body !== comment.body || rendered.contextValue !== 'saved') {
            rendered.body = comment.body;
            rendered.contextValue = 'saved';
            thread.comments = [rendered];
          }
        } else {
          thread.comments = [this.previewComment(comment)];
        }
      }
    }
    this.threadIds.set(thread, comment.id);
    thread.range = this.asRange(location, comment.anchor.lines.at(-1)?.length ?? 0);
    thread.contextValue = thread.comments[0]?.mode === vscode.CommentMode.Editing ? 'editing' : 'saved';
    thread.canReply = false;
    thread.label = comment.resolved ? 'Resolved' : (location.status === 'moved' ? 'Review · moved' : 'Review');
    thread.state = comment.resolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
  }
  private disposeThreads(): void {
    for (const thread of this.threads.values()) { thread.dispose(); }
    this.threads.clear();
    this.locations.clear();
  }
  async openDiff(input: Node | Change | string): Promise<void> {
    const session = this.session;
    if (!session) { throw new Error('Start a review first.'); }
    const node = typeof input === 'object' && 'type' in input ? input as Node : undefined;
    const note = node?.type === 'comment' ? node.comment : undefined;
    const file = typeof input === 'string' ? input : note ? note.path : node?.type === 'file' ? node.change.path : (input as Change).path;
    const change = this.changes.find(c => c.path === file) ?? (node?.type === 'file' ? node.change :
      { path: file, basePath: note?.basePath ?? file, status: 'M' });
    if (!relativeFile(session.rootPath, path.resolve(session.rootPath, change.path))) { throw new Error('File is outside the repository.'); }
    let baseEmpty = change.status === 'A' || change.status === 'U';
    if (!baseEmpty) { try { await this.baseContent(change.basePath); } catch { baseEmpty = true; } }
    const left = this.baseUri(change.basePath, baseEmpty);
    let right = this.fileUri(change.path);
    const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === right.toString());
    if (!open) {
      try { await vscode.workspace.fs.stat(right); }
      catch { right = this.baseUri(change.path, true, session, true); }
    }
    // The modified URI is the real workspace document; do not make a snapshot here.
    await vscode.commands.executeCommand('vscode.diff', left, right,
      change.path + ' (' + session.baseLabel + ' ↔ workspace)', { preview: true });
    if (note) {
      const thread = this.threads.get(note.id);
      if (thread) { thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded; }
      const location = this.locations.get(note.id) ?? locateAnchor(note.anchor, await this.sourceFor(note));
      const target = note.side === 'base' ? left : right;
      const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === target.toString());
      if (editor) {
        const range = editor.document.validateRange(this.asRange(location, note.anchor.lines.at(-1)?.length ?? 0));
        editor.selection = new vscode.Selection(range.start, range.end);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      }
      if (location.status === 'outdated' || location.status === 'ambiguous') {
        void vscode.window.showWarningMessage('This comment needs its location confirmed. Select the intended code and use Attach Comment to Current Selection.');
      }
    }
  }
  async addComment(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !this.targetForUri(editor.document.uri)) { throw new Error('Select code in a file belonging to this review.'); }
    if (editor.document.getText().includes('\0')) { throw new Error('Binary files cannot have text comments.'); }
    const selection = editor.document.validateRange(editor.selection);
    const end = this.inclusiveEndLine(selection);
    const range = new vscode.Range(selection.start.line, 0, end, editor.document.lineAt(end).text.length);
    const draft = this.controller.createCommentThread(editor.document.uri, range, []);
    draft.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  }
  async addNote(uri: vscode.Uri, range: vscode.Range, body: string, draft?: vscode.CommentThread): Promise<ReviewComment> {
    const session = this.session;
    const target = this.targetForUri(uri);
    if (!session || !target) { throw new Error('The selected file is outside the active review.'); }
    if (!body.trim()) { throw new Error('A comment cannot be empty.'); }
    const document = await vscode.workspace.openTextDocument(uri);
    if (document.getText().includes('\0')) { throw new Error('Binary files cannot have text comments.'); }
    range = document.validateRange(range);
    const end = this.inclusiveEndLine(range);
    const comment = makeComment({ ...target, body: body.trim(),
      anchor: captureAnchor(document.getText(), { start: range.start.line, end }, this.contextLines) });
    session.comments.push(comment);
    const location = locateAnchor(comment.anchor, document.getText());
    this.locations.set(comment.id, location);
    if (draft) { this.threads.set(comment.id, draft); }
    this.syncThread(comment, location);
    this.threads.get(comment.id)!.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    this.publishReview();
    try { await this.save(); }
    catch (error) { throw new Error('Comment is visible but could not be saved. Edit it to retry. ' + errorMessage(error)); }
    return comment;
  }
  async reply(reply: vscode.CommentReply): Promise<void> {
    if (!reply?.thread || !reply.text?.trim()) { return; }
    await this.addNote(reply.thread.uri, reply.thread.range, reply.text, reply.thread);
  }
  private commentFrom(input: unknown): ReviewComment | undefined {
    if (!this.session || !input || typeof input !== 'object') { return undefined; }
    const value = input as { type?: string; sessionId?: string; comment?: { id: string }; id?: string; reviewId?: string; thread?: vscode.CommentThread };
    if (value.sessionId && value.sessionId !== this.session.id) { return undefined; }
    const thread = value.thread ?? input as vscode.CommentThread;
    const id = value.type === 'comment' ? value.comment?.id : value.reviewId ?? this.threadIds.get(thread) ?? value.id;
    return this.session.comments.find(c => c.id === id);
  }
  async editComment(input: unknown): Promise<void> {
    const note = this.commentFrom(input);
    if (!note) { return; }
    const thread = this.threads.get(note.id);
    if (thread) {
      const editable = (thread.comments[0] as EditableComment | undefined) ?? this.previewComment(note);
      editable.body = note.body;
      editable.mode = vscode.CommentMode.Editing;
      editable.contextValue = 'editing';
      thread.comments = [editable];
      thread.contextValue = 'editing';
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      return;
    }
    const text = await vscode.window.showInputBox({ title: 'Edit review comment', value: note.body });
    if (text?.trim()) {
      note.body = text.trim();
      note.updatedAt = new Date().toISOString();
      this.publishReview();
      await this.save();
    }
  }
  async saveEdit(input: EditableComment): Promise<void> {
    const note = this.commentFrom(input);
    if (!note) { return; }
    const body = typeof input.body === 'string' ? input.body : input.body.value;
    if (!body.trim()) { throw new Error('A comment cannot be empty.'); }
    note.body = body.trim();
    note.updatedAt = new Date().toISOString();
    const thread = this.threads.get(note.id);
    if (thread) {
      const rendered = (thread.comments[0] as EditableComment | undefined) ?? this.previewComment(note);
      rendered.body = note.body;
      rendered.mode = vscode.CommentMode.Preview;
      rendered.contextValue = 'saved';
      thread.comments = [rendered];
      thread.contextValue = 'saved';
    }
    this.publishReview();
    await this.save();
  }
  async cancelEdit(input: EditableComment): Promise<void> {
    const note = this.commentFrom(input);
    if (!note) { return; }
    const thread = this.threads.get(note.id);
    if (!thread || thread.comments[0]?.mode !== vscode.CommentMode.Editing) { return; }
    const rendered = thread.comments[0] as EditableComment;
    rendered.body = note.body;
    rendered.mode = vscode.CommentMode.Preview;
    rendered.contextValue = 'saved';
    thread.comments = [rendered];
    thread.contextValue = 'saved';
  }
  async discard(input: unknown): Promise<void> {
    const note = this.commentFrom(input);
    if (!note) {
      if (input && typeof input === 'object' && 'dispose' in input && typeof input.dispose === 'function') {
        input.dispose();
      }
      return;
    }
    this.session!.comments = this.session!.comments.filter(c => c.id !== note.id);
    this.threads.get(note.id)?.dispose();
    this.threads.delete(note.id);
    this.locations.delete(note.id);
    this.publishReview();
    await this.save();
  }
  async toggleResolved(input: unknown): Promise<void> {
    const note = this.commentFrom(input);
    if (!note) { return; }
    note.resolved = !note.resolved;
    note.updatedAt = new Date().toISOString();
    const thread = this.threads.get(note.id);
    if (thread) {
      thread.state = note.resolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
      thread.label = note.resolved ? 'Resolved' : (this.locations.get(note.id)?.status === 'moved' ? 'Review · moved' : 'Review');
    }
    this.publishReview();
    await this.save();
  }
  async reanchor(input: unknown): Promise<void> {
    const note = this.commentFrom(input);
    const editor = vscode.window.activeTextEditor;
    if (!note || !editor) { throw new Error('Select the intended code before attaching the comment.'); }
    const target = this.targetForUri(editor.document.uri);
    if (!target || target.path !== note.path || target.side !== note.side) {
      throw new Error('Select code in the same file and on the same side as the comment.');
    }
    const selection = editor.selection;
    const end = this.inclusiveEndLine(selection);
    note.anchor = captureAnchor(editor.document.getText(), { start: selection.start.line, end }, this.contextLines);
    note.updatedAt = new Date().toISOString();
    const location = locateAnchor(note.anchor, editor.document.getText());
    this.locations.set(note.id, location);
    this.syncThread(note, location);
    this.publishReview();
    await this.save();
  }
  async buildExport(): Promise<ReturnType<typeof exportData>> {
    const session = this.session;
    if (!session) { throw new Error('Start a review first.'); }
    const comments: CommentExport[] = [];
    for (const comment of session.comments) {
      try {
        const text = await this.sourceFor(comment);
        const location = locateAnchor(comment.anchor, text);
        const lines = linesOf(text);
        const currentSnippet = location.status === 'outdated' || location.status === 'ambiguous' ? undefined :
          lines.slice(Math.max(0, location.start - this.contextLines), location.end + 1 + this.contextLines).join('\n');
        comments.push({ comment, location, currentSnippet, sourceHash: hash(text) });
      } catch {
        comments.push({ comment, location: { start: comment.anchor.start, end: comment.anchor.end, status: 'outdated' } });
      }
    }
    const head = await resolveCommit(session.rootPath, 'HEAD', this.git);
    return exportData(session, comments, head);
  }
  async copyReview(): Promise<string> {
    const text = markdownReview(await this.buildExport(),
      vscode.workspace.getConfiguration(NAMESPACE).get('includeResolvedInExport', false));
    await vscode.env.clipboard.writeText(text);
    void vscode.window.showInformationMessage('Review copied. Paste it into your LLM conversation.');
    return text;
  }
  async exportReview(): Promise<void> {
    if (!this.session) { throw new Error('Start a review first.'); }
    const format = await vscode.window.showQuickPick(['Markdown (.md)', 'JSON (.json)'], { title: 'Export review' });
    if (!format) { return; }
    const json = format.startsWith('JSON');
    const uri = await vscode.window.showSaveDialog({
      defaultUri: this.fileUri('review-' + this.session!.baseSha.slice(0, 8) + (json ? '.json' : '.md')),
      filters: json ? { JSON: ['json'] } : { Markdown: ['md'] }
    });
    if (!uri) { return; }
    const data = await this.buildExport();
    const text = json ? JSON.stringify(data, null, 2) : markdownReview(data,
      vscode.workspace.getConfiguration(NAMESPACE).get('includeResolvedInExport', false));
    await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
  }
  dispose(): void {
    this.disposed = true;
    ++this.generation;
    if (this.timer) { clearTimeout(this.timer); }
    this.disposeThreads();
    for (const disposable of this.disposables) { disposable.dispose(); }
  }
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
export async function activate(context: vscode.ExtensionContext): Promise<ReviewExtension> {
  const app = new ReviewExtension(context);
  context.subscriptions.push(app);
  try { await app.initialize(); }
  catch (error) { void vscode.window.showWarningMessage('Local Diff Review: could not restore review. ' + errorMessage(error)); }
  return app;
}
