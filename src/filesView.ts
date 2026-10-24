import * as vscode from 'vscode';
import { posix } from 'node:path';
import { AnchorStatus, Side } from './model';
import { FILES_SCHEME, FILES_VIEW_ID, NAMESPACE } from './identifiers';

export interface FileComment {
  id: string;
  body: string;
  side: Side;
  line: number;
  location: AnchorStatus;
  resolved: boolean;
}
export interface ReviewFile {
  path: string;
  status: string;
  reviewed: boolean;
  comments: FileComment[];
}
export interface FilesState {
  sessionId?: string;
  baseLabel?: string;
  files: ReviewFile[];
}
export type FilesAction = { sessionId?: string } & (
  { type: 'start' | 'resume' } |
  { type: 'openFile'; path: string } |
  { type: 'setReviewed'; path: string; reviewed: boolean } |
  { type: 'openComment' | 'editComment' | 'toggleResolved' | 'discardComment' | 'reanchorComment'; id: string }
);

interface FileNode { type: 'file'; sessionId: string; file: ReviewFile }
interface CommentNode { type: 'comment'; sessionId: string; filePath: string; comment: FileComment }
export type FilesNode = FileNode | CommentNode;

export class ReviewFilesView implements vscode.TreeDataProvider<FilesNode>, vscode.FileDecorationProvider, vscode.Disposable {
  private emitter = new vscode.EventEmitter<FilesNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private decorationEmitter = new vscode.EventEmitter<vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this.decorationEmitter.event;
  private decorationRegistration: vscode.Disposable;
  private decorations = new Map<string, { uri: vscode.Uri; value: vscode.FileDecoration }>();
  private tree: vscode.TreeView<FilesNode>;
  private checkboxListener: vscode.Disposable;
  private roots: FileNode[] = [];
  private fileNameCounts = new Map<string, number>();
  private files = new Map<string, FileNode>();
  private comments = new Map<string, CommentNode>();
  private children = new Map<string, CommentNode[]>();

  constructor(private readonly resourceUri: (file: string) => vscode.Uri,
    private readonly onAction: (action: FilesAction) => Promise<void>) {
    this.tree = vscode.window.createTreeView(FILES_VIEW_ID, {
      treeDataProvider: this, showCollapseAll: true, manageCheckboxStateManually: true
    });
    this.decorationRegistration = vscode.window.registerFileDecorationProvider(this);
    this.checkboxListener = this.tree.onDidChangeCheckboxState(async event => {
      try {
        for (const [node, state] of event.items) {
          if (node.type !== 'file') { continue; }
          await this.onAction({ type: 'setReviewed', sessionId: node.sessionId,
            path: node.file.path, reviewed: state === vscode.TreeItemCheckboxState.Checked });
        }
      } catch (error) {
        void vscode.window.showErrorMessage('Local Diff Review: ' + (error instanceof Error ? error.message : String(error)));
        this.emitter.fire(undefined);
      }
    });
  }

  update(state: FilesState): void {
    const files = new Map<string, FileNode>();
    const comments = new Map<string, CommentNode>();
    const decorations = new Map<string, { uri: vscode.Uri; value: vscode.FileDecoration }>();
    this.roots = [];
    this.fileNameCounts.clear();
    this.children.clear();
    if (state.sessionId) {
      for (const file of state.files) {
        const name = posix.basename(file.path);
        this.fileNameCounts.set(name, (this.fileNameCounts.get(name) ?? 0) + 1);
        const key = state.sessionId + ':' + file.path;
        const node = this.files.get(key) ?? { type: 'file' as const, sessionId: state.sessionId, file };
        node.file = file;
        files.set(key, node);
        this.roots.push(node);
        const uri = this.rowUri(node);
        const value = this.decoration(file);
        if (value) { decorations.set(uri.toString(), { uri, value }); }
        const children: CommentNode[] = [];
        for (const comment of file.comments) {
          const id = state.sessionId + ':' + comment.id;
          const child = this.comments.get(id) ?? {
            type: 'comment' as const, sessionId: state.sessionId, filePath: file.path, comment
          };
          child.comment = comment;
          child.filePath = file.path;
          comments.set(id, child);
          children.push(child);
        }
        this.children.set(key, children);
      }
    }
    this.files = files;
    this.comments = comments;
    const changed: vscode.Uri[] = [];
    for (const key of new Set([...this.decorations.keys(), ...decorations.keys()])) {
      const old = this.decorations.get(key), next = decorations.get(key);
      if (old?.value.badge !== next?.value.badge || old?.value.tooltip !== next?.value.tooltip ||
        old?.value.color?.id !== next?.value.color?.id) { changed.push((next ?? old)!.uri); }
    }
    this.decorations = decorations;
    if (changed.length) { this.decorationEmitter.fire(changed); }
    this.tree.description = state.baseLabel ? state.baseLabel + ' → workspace' : undefined;
    this.tree.message = state.sessionId && !this.roots.length ? 'No changed files or saved comments for this baseline.' : undefined;
    this.emitter.fire(undefined);
  }

  setReviewed(sessionId: string, path: string, reviewed: boolean): void {
    const node = this.files.get(sessionId + ':' + path);
    if (!node || node.file.reviewed === reviewed) { return; }
    node.file.reviewed = reviewed;
    // Persisting a checkbox is not a file change: don't rebuild the tree or invalidate decorations.
    this.emitter.fire(node);
  }

  private rowUri(node: FileNode): vscode.Uri {
    // Use a list-only URI so Git's decoration provider doesn't re-read repository status on row updates.
    // Opening the row still goes through openDiff with the real workspace URI.
    return this.resourceUri(node.file.path).with({ scheme: FILES_SCHEME, query: node.sessionId, fragment: '' });
  }
  private decoration(file: ReviewFile): vscode.FileDecoration | undefined {
    const status = /^[MADRCUTXB]$/.test(file.status) ? file.status : '';
    if (!status) { return undefined; }
    const colors: Record<string, string> = { M: 'modified', A: 'added', U: 'untracked', D: 'deleted', R: 'renamed' };
    const color = 'gitDecoration.' + (colors[status] ?? 'modified') + 'ResourceForeground';
    // Comments are shown as expandable child nodes, not as badges or file colors.
    return new vscode.FileDecoration(status, status, new vscode.ThemeColor(color));
  }
  private commentStatus(file: ReviewFile): string {
    return !file.comments.length ? 'No comments' : file.comments.some(comment => !comment.resolved)
      ? 'Unresolved comments' : 'All comments resolved';
  }
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    return this.decorations.get(uri.toString())?.value;
  }

  getChildren(node?: FilesNode): FilesNode[] {
    if (!node) { return this.roots; }
    return node.type === 'file' ? this.children.get(node.sessionId + ':' + node.file.path) ?? [] : [];
  }
  getParent(node: FilesNode): FilesNode | undefined {
    return node.type === 'comment' ? this.files.get(node.sessionId + ':' + node.filePath) : undefined;
  }
  getTreeItem(node: FilesNode): vscode.TreeItem {
    if (node.type === 'file') {
      const file = node.file;
      const name = posix.basename(file.path);
      const item = new vscode.TreeItem(name,
        file.comments.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
      item.description = (this.fileNameCounts.get(name) ?? 0) > 1 ? file.path : undefined;
      item.id = 'file:' + node.sessionId + ':' + file.path;
      item.resourceUri = this.rowUri(node);
      item.iconPath = new vscode.ThemeIcon('file');
      item.contextValue = 'reviewFile';
      item.checkboxState = { state: file.reviewed ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked,
        tooltip: file.reviewed ? 'Mark as not reviewed' : 'Mark as reviewed' };
      item.tooltip = this.resourceUri(file.path).fsPath + '\n' + this.commentStatus(file);
      item.accessibilityInformation = { label: file.path + ', ' + this.commentStatus(file) + ', ' +
        (file.reviewed ? 'reviewed' : 'not reviewed') };
      item.command = { command: NAMESPACE + '.fileAction', title: 'Open Diff',
        arguments: [{ type: 'openFile', sessionId: node.sessionId, path: file.path }] };
      return item;
    }
    const comment = node.comment;
    const stale = comment.location === 'outdated' || comment.location === 'ambiguous';
    const item = new vscode.TreeItem(comment.body.split(/\r?\n/)[0].slice(0, 100), vscode.TreeItemCollapsibleState.None);
    item.id = 'comment:' + node.sessionId + ':' + comment.id;
    item.contextValue = 'reviewComment';
    item.description = comment.side + ':' + comment.line +
      (comment.location !== 'current' ? ' · ' + comment.location : '') + (comment.resolved ? ' · resolved' : '');
    item.iconPath = new vscode.ThemeIcon(stale ? 'warning' : comment.resolved ? 'pass' : 'comment');
    item.tooltip = comment.body;
    item.command = { command: NAMESPACE + '.fileAction', title: 'Open Comment',
      arguments: [{ type: 'openComment', sessionId: node.sessionId, id: comment.id }] };
    return item;
  }
  dispose(): void {
    this.checkboxListener.dispose();
    this.tree.dispose();
    this.emitter.dispose();
    this.decorationRegistration.dispose();
    this.decorationEmitter.dispose();
    this.decorations.clear();
  }
}
