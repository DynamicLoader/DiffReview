const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { runGit } = require('../dist/git');

// Mock only the VS Code API boundary; Git, files, anchors and exports remain real.
class Uri {
  constructor(scheme, path, query = '', authority = '', fragment = '') { Object.assign(this, { scheme, path, query, authority, fragment }); }
  get fsPath() { return this.path; }
  toString() {
    const urlPath = this.path.replaceAll('\\', '/');
    const absolutePath = /^[A-Za-z]:\//.test(urlPath) ? '/' + urlPath : urlPath;
    return this.scheme + '://' + this.authority + encodeURI(absolutePath) + (this.query ? '?' + encodeURIComponent(this.query) : '');
  }
  with(values) { return Object.assign(new Uri(this.scheme, this.path, this.query, this.authority, this.fragment), values); }
  static file(p) { return new Uri('file', path.resolve(p)); }
  static parse(value) {
    const u = new URL(value);
    let uriPath = decodeURI(u.pathname);
    if (process.platform === 'win32' && /^\/[A-Za-z]:\//.test(uriPath)) {
      uriPath = uriPath.slice(1).replaceAll('/', '\\');
    }
    return new Uri(u.protocol.slice(0, -1), uriPath, decodeURIComponent(u.search.slice(1)), u.host);
  }
  static joinPath(root, file) { return root.with({ path: path.posix.join(root.path, file), query: '' }); }
}
class Position { constructor(line, character) { Object.assign(this, { line, character }); } }
class Range {
  constructor(a, b, c, d) {
    if (typeof a === 'number') { this.start = new Position(a, b); this.end = new Position(c, d); }
    else { this.start = a; this.end = b; }
  }
}
class EventEmitter {
  event = () => ({ dispose() {} });
  fire() {}
  dispose() {}
}
const documents = new Map(), providers = new Map(), commands = new Map(), calls = [];
const inputQueue = [];
let clipboard = '';
let state = {};
const disposable = () => ({ dispose() {} });
function doc(uri, text) {
  return {
    uri, isDirty: false, text, get lineCount() { return this.text.split('\n').length; },
    getText() { return this.text; }, lineAt(i) { return { text: this.text.split('\n')[i] ?? '' }; },
    validateRange(range) {
      return new Range(Math.min(range.start.line, this.lineCount - 1), range.start.character,
        Math.min(range.end.line, this.lineCount - 1), range.end.character);
    }
  };
}
const vscode = {
  Uri, Position, Range, Selection: Range, EventEmitter,
  CommentMode: { Preview: 1, Editing: 0 }, CommentThreadState: { Resolved: 1, Unresolved: 0 },
  CommentThreadCollapsibleState: { Collapsed: 0, Expanded: 1 }, TreeItemCollapsibleState: { None: 0, Collapsed: 1 },
  StatusBarAlignment: { Left: 0 }, TextEditorRevealType: { InCenterIfOutsideViewport: 0 },
  TreeItem: class { constructor(label, collapsibleState) { Object.assign(this, { label, collapsibleState }); } },
  ThemeIcon: class { constructor(id) { this.id = id; } },
  comments: {
    createCommentController() {
      return { dispose() {}, createCommentThread(uri, range, comments) {
        return { uri, range, comments, disposed: false, dispose() { this.disposed = true; } };
      } };
    }
  },
  commands: {
    registerCommand(name, handler) { commands.set(name, handler); return { dispose() { commands.delete(name); } }; },
    async executeCommand(name, ...args) {
      calls.push({ name, args });
      if (commands.has(name)) { return commands.get(name)(...args); }
    }
  },
  workspace: {
    workspaceFolders: [],
    get textDocuments() { return [...documents.values()]; },
    getConfiguration() { return { get(_name, fallback) { return fallback; } }; },
    registerTextDocumentContentProvider(scheme, provider) { providers.set(scheme, provider); return disposable(); },
    async openTextDocument(uri) {
      const key = uri.toString();
      if (!documents.has(key)) {
        const content = providers.has(uri.scheme) ? await providers.get(uri.scheme).provideTextDocumentContent(uri) : await fs.readFile(uri.fsPath, 'utf8');
        documents.set(key, doc(uri, content));
      }
      return documents.get(key);
    },
    fs: { readFile: uri => fs.readFile(uri.fsPath), writeFile: (uri, bytes) => fs.writeFile(uri.fsPath, bytes), stat: uri => fs.stat(uri.fsPath) },
    onDidChangeTextDocument: disposable, onDidSaveTextDocument: disposable
  },
  window: {
    activeTextEditor: undefined, visibleTextEditors: [],
    createTreeView() { return disposable(); },
    createStatusBarItem() { return { ...disposable(), show() {}, hide() {} }; },
    onDidChangeWindowState: disposable,
    showErrorMessage(message) { throw new Error(message); },
    showWarningMessage: async () => {}, showInformationMessage: async () => {},
    showInputBox: async () => inputQueue.shift(),
    showQuickPick: async () => inputQueue.shift(),
    showSaveDialog: async () => inputQueue.shift(),
    showTextDocument: async document => ({ document, selection: new Range(0, 0, 0, 0) })
  },
  env: { clipboard: { async writeText(text) { clipboard = text; }, async readText() { return clipboard; } } }
};
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) { return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain); };
const { ReviewExtension } = require('../dist/extension');
Module._load = originalLoad;

test('extension workflow against a real repository and mock VS Code UI boundary', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diff-review-extension-'));
  const rootUri = Uri.file(root);
  const context = {
    subscriptions: [],
    workspaceState: { get(key, fallback) { return state[key] ?? fallback; },
      async update(key, value) { state[key] = JSON.parse(JSON.stringify(value)); } }
  };
  let app;
  try {
    await runGit(root, ['init', '-q']);
    await runGit(root, ['config', 'user.name', 'Diff Review Test']);
    await runGit(root, ['config', 'user.email', 'test@example.invalid']);
    await fs.writeFile(path.join(root, 'main.ts'), 'before\nold\nafter\n');
    await fs.writeFile(path.join(root, 'clean.ts'), 'unchanged\n');
    await fs.writeFile(path.join(root, 'gone.ts'), 'removed\n');
    await runGit(root, ['add', '--all']); await runGit(root, ['commit', '-qm', 'baseline']);
    await fs.writeFile(path.join(root, 'main.ts'), 'before\nnew\nafter\n');
    await fs.unlink(path.join(root, 'gone.ts'));
    await fs.writeFile(path.join(root, 'new.ts'), 'added\n');
    vscode.workspace.workspaceFolders = [{ uri: rootUri }];
    app = new ReviewExtension(context);
    await app.start('HEAD', rootUri);
    const main = app.fileUri('main.ts');
    let currentNote, baseNote;

    await t.test('diff uses a virtual baseline and real modified file, including added/deleted files', async () => {
      await app.openDiff('main.ts');
      let call = calls.filter(c => c.name === 'vscode.diff').at(-1);
      assert.equal(call.args[0].scheme, 'diff-review-base');
      assert.equal(call.args[1].toString(), main.toString());
      assert.equal((await vscode.workspace.openTextDocument(call.args[0])).getText(), 'before\nold\nafter\n');
      await app.openDiff('gone.ts');
      call = calls.filter(c => c.name === 'vscode.diff').at(-1);
      assert.equal((await vscode.workspace.openTextDocument(call.args[1])).getText(), '');
      await app.openDiff('new.ts');
      call = calls.filter(c => c.name === 'vscode.diff').at(-1);
      assert.equal((await vscode.workspace.openTextDocument(call.args[0])).getText(), '');
      assert.equal(call.args[1].scheme, 'file');
    });
    await t.test('left/current comments, gutter submission and persisted draft data', async () => {
      currentNote = await app.addNote(main, new Range(1, 0, 2, 0), 'Current comment\nMultiline');
      baseNote = await app.addNote(app.baseUri('main.ts'), new Range(1, 0, 1, 0), 'Base comment');
      assert.equal(currentNote.anchor.end, 1);
      assert.equal(baseNote.side, 'base');
      const draft = app.controller.createCommentThread(main, new Range(0, 0, 0, 0), []);
      const createThread = app.controller.createCommentThread;
      let newThreadCount = 0;
      app.controller.createCommentThread = (...args) => {
        newThreadCount++;
        return createThread(...args);
      };
      const update = context.workspaceState.update;
      let releaseUpdate;
      const heldUpdate = new Promise(resolve => { releaseUpdate = resolve; });
      let updateStarted;
      const started = new Promise(resolve => { updateStarted = resolve; });
      context.workspaceState.update = async (...args) => {
        updateStarted();
        await heldUpdate;
        return update(...args);
      };
      const saving = app.reply({ thread: draft, text: 'Gutter comment' });
      try {
        await started;
        const savedNote = app.session.comments.at(-1);
        assert.equal(app.threads.get(savedNote.id), draft, 'reuse the draft thread');
        assert.equal(draft.comments[0].body, 'Gutter comment', 'show the comment before persistence finishes');
        assert.equal(draft.disposed, false);
        assert.equal(draft.canReply, false);
        assert.equal(newThreadCount, 0, 'do not create a second thread');
      } finally {
        releaseUpdate();
        await saving;
        context.workspaceState.update = update;
        app.controller.createCommentThread = createThread;
      }
      assert.equal(app.session.comments.length, 3);
      assert.equal(state['reviews.v1'].sessions[0].comments.length, 3);
      const abandoned = app.controller.createCommentThread(main, new Range(0, 0, 0, 0), []);
      await vscode.commands.executeCommand('diffReview.discardDraft', { thread: abandoned, text: '' });
      assert.equal(abandoned.disposed, true);
      assert.equal(app.session.comments.length, 3);
      await assert.rejects(app.addNote(Uri.file('/outside.ts'), new Range(0, 0, 0, 0), 'Invalid'), /outside/);
    });
    await t.test('a multi-line selection opens a native draft anchored to every selected line', async () => {
      const document = await vscode.workspace.openTextDocument(main);
      const previousEditor = vscode.window.activeTextEditor;
      const createThread = app.controller.createCommentThread;
      let draft;
      vscode.window.activeTextEditor = { document, selection: new Range(0, 3, 2, 0) };
      app.controller.createCommentThread = (...args) => {
        draft = createThread(...args);
        return draft;
      };
      try {
        await app.addComment();
        assert.ok(draft);
        assert.equal(draft.range.start.line, 0);
        assert.equal(draft.range.end.line, 1, 'an end at column zero excludes the next line');
        assert.equal(draft.range.end.character, document.lineAt(1).text.length);
        assert.equal(draft.collapsibleState, vscode.CommentThreadCollapsibleState.Expanded);
        await app.reply({ thread: draft, text: 'Review both lines\nKeep context' });
        const comment = app.session.comments.at(-1);
        assert.equal(comment.anchor.start, 0);
        assert.equal(comment.anchor.end, 1);
        assert.equal(comment.body, 'Review both lines\nKeep context');
        assert.equal(app.threads.get(comment.id), draft);
        assert.equal(draft.range.end.character, document.lineAt(1).text.length);
        await app.discard(comment);
      } finally {
        vscode.window.activeTextEditor = previousEditor;
        app.controller.createCommentThread = createThread;
      }
      assert.equal(app.session.comments.length, 3);
    });
    await t.test('native edit save and cancel preserve multiline comments', async () => {
      await app.editComment(currentNote);
      const editable = app.threads.get(currentNote.id).comments[0];
      assert.equal(editable.mode, vscode.CommentMode.Editing);
      await app.refresh();
      assert.equal(app.threads.get(currentNote.id).comments[0].mode, vscode.CommentMode.Editing);
      const update = context.workspaceState.update;
      let releaseUpdate;
      const heldUpdate = new Promise(resolve => { releaseUpdate = resolve; });
      let updateStarted;
      const started = new Promise(resolve => { updateStarted = resolve; });
      context.workspaceState.update = async (...args) => {
        updateStarted();
        await heldUpdate;
        return update(...args);
      };
      const saving = app.saveEdit({ ...editable, body: 'Edited\nSecond line' });
      try {
        await started;
        assert.equal(app.threads.get(currentNote.id).comments[0].mode, vscode.CommentMode.Preview);
        assert.equal(app.threads.get(currentNote.id).comments[0].body, 'Edited\nSecond line');
        assert.equal(app.threads.get(currentNote.id).comments[0], editable, 'keep the same comment object');
      } finally {
        releaseUpdate();
        await saving;
        context.workspaceState.update = update;
      }
      assert.equal(currentNote.body, 'Edited\nSecond line');
      await app.editComment(currentNote);
      const editingAgain = app.threads.get(currentNote.id).comments[0];
      await app.editComment(baseNote);
      const otherEditing = app.threads.get(baseNote.id).comments[0];
      assert.equal(app.threads.get(currentNote.id).contextValue, 'editing');
      assert.equal(app.threads.get(baseNote.id).contextValue, 'editing');
      await app.cancelEdit(editingAgain);
      assert.equal(app.threads.get(currentNote.id).comments[0].mode, vscode.CommentMode.Preview);
      assert.equal(app.threads.get(currentNote.id).comments[0], editingAgain);
      assert.equal(app.threads.get(currentNote.id).contextValue, 'saved');
      assert.equal(app.threads.get(baseNote.id).comments[0].mode, vscode.CommentMode.Editing,
        'discarding one edit must not close another');
      await app.cancelEdit(otherEditing);
      assert.equal(app.threads.get(baseNote.id).comments[0].mode, vscode.CommentMode.Preview);
      assert.equal(app.threads.get(baseNote.id).contextValue, 'saved');
    });
    await t.test('unsaved buffers appear and anchors safely move, expire and reattach', async () => {
      const document = await vscode.workspace.openTextDocument(main);
      document.text = 'prefix\n' + document.text; document.isDirty = true;
      const clean = await vscode.workspace.openTextDocument(app.fileUri('clean.ts'));
      clean.text = '// dirty\n' + clean.text; clean.isDirty = true;
      await app.refresh();
      assert.ok(app.changedFiles.find(c => c.path === 'clean.ts'));
      let exported = await app.buildExport();
      assert.equal(exported.comments.find(c => c.comment.id === currentNote.id).location.status, 'moved');
      assert.equal(exported.comments.find(c => c.comment.id === currentNote.id).location.start, 2);
      assert.equal(exported.comments.find(c => c.comment.id === baseNote.id).location.start, 1);
      document.text = document.text.replace('new', 'edited');
      await app.refresh();
      assert.equal(app.threads.has(currentNote.id), false);
      assert.equal((await app.buildExport()).comments.find(c => c.comment.id === currentNote.id).location.status, 'outdated');
      vscode.window.activeTextEditor = { document, selection: new Range(2, 0, 2, 4) };
      await app.reanchor(currentNote);
      assert.equal((await app.buildExport()).comments.find(c => c.comment.id === currentNote.id).location.status, 'current');
    });
    await t.test('copy, Markdown and JSON exports include excerpts and filter resolved notes', async () => {
      await app.toggleResolved(currentNote);
      const text = await app.copyReview();
      assert.equal(clipboard, text);
      assert.match(text, /Base comment/);
      assert.doesNotMatch(text, /Edited\nSecond line/);
      const mdPath = Uri.file(path.join(root, 'review.md'));
      inputQueue.push('Markdown (.md)', mdPath);
      await app.exportReview();
      assert.match(await fs.readFile(mdPath.fsPath, 'utf8'), /Base comment/);
      const jsonPath = Uri.file(path.join(root, 'review.json'));
      inputQueue.push('JSON (.json)', jsonPath);
      await app.exportReview();
      const data = JSON.parse(await fs.readFile(jsonPath.fsPath, 'utf8'));
      assert.equal(data.schemaVersion, 1);
      assert.equal(data.comments.length, 3);
      assert.equal(data.comments.find(n => n.comment.id === currentNote.id).comment.resolved, true);
    });
    await t.test('deletion and reactivation restore durable workspace state', async () => {
      const id = app.session.id;
      await app.discard(baseNote);
      assert.equal(app.session.comments.length, 2);
      app.dispose();
      app = new ReviewExtension(context);
      await app.initialize();
      assert.equal(app.session.id, id);
      assert.equal(app.session.comments.length, 2);
      await app.start('HEAD', rootUri);
      assert.equal(app.session.id, id, 'same SHA resumes the original session');
    });
    await t.test('view title context reopens baseline picker instead of being parsed as a ref', async () => {
      const id = app.session.id;
      inputQueue.push({ label: 'HEAD', ref: 'HEAD' });
      await vscode.commands.executeCommand('diffReview.start', { viewId: 'diffReview.files' });
      assert.equal(app.session.id, id, 'selecting the same baseline resumes the current review');
    });
  } finally {
    app?.dispose(); documents.clear(); providers.clear(); commands.clear(); state = {};
    await fs.rm(root, { recursive: true, force: true });
  }
});
