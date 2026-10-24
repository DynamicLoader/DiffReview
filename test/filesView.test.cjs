const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const manifest = require('../package.json');
// Model an upgrade where the workbench still holds the old Webview descriptor.
const viewDescriptors = new Map([['legacy.webview', { type: 'webview' }]]);
for (const views of Object.values(manifest.contributes.views)) {
  for (const view of views) { if (!viewDescriptors.has(view.id)) { viewDescriptors.set(view.id, view); } }
}

// Test the native TreeView API boundary without starting VS Code.
class EventEmitter {
  listeners = new Set();
  event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
  fire(value) { for (const listener of this.listeners) { listener(value); } }
  dispose() { this.listeners.clear(); }
}
const trees = [];
const vscode = {
  EventEmitter,
  TreeItemCheckboxState: { Unchecked: 0, Checked: 1 },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1 },
  TreeItem: class { constructor(label, collapsibleState) { Object.assign(this, { label, collapsibleState }); } },
  ThemeIcon: class { constructor(id) { this.id = id; } },
  ThemeColor: class { constructor(id) { this.id = id; } },
  FileDecoration: class { constructor(badge, tooltip, color) { Object.assign(this, { badge, tooltip, color }); } },
  window: {
    registerFileDecorationProvider(provider) { return { dispose() {} }; },
    createTreeView(id, options) {
      const descriptor = viewDescriptors.get(id);
      if (!descriptor || (descriptor.type ?? 'tree') !== 'tree') { throw new Error('No view is registered with id: ' + id); }
      let change;
      const tree = { id, options,
        onDidChangeCheckboxState(listener) { change = listener; return { dispose() {} }; },
        async changeCheckbox(items) { await change({ items }); }, dispose() {}
      };
      trees.push(tree);
      return tree;
    },
    showErrorMessage(message) { throw new Error(message); }
  }
};
const originalLoad = Module._load;
let ReviewFilesView;
try {
  Module._load = function(request, parent, isMain) { return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain); };
  ({ ReviewFilesView } = require('../dist/filesView'));
} finally { Module._load = originalLoad; }

function fixture() {
  const actions = [];
  const uri = (path, scheme = 'file', query = '') => ({ path, fsPath: path, scheme, query,
    with(values) { return uri(values.path ?? path, values.scheme ?? scheme, values.query ?? query); },
    toString() { return scheme + '://' + path + '?' + query; } });
  const provider = new ReviewFilesView(file => uri('/repo/' + file), async action => { actions.push(action); });
  return { provider, actions, tree: trees.at(-1) };
}
function comment(id) { return { id, body: 'Review this\nSecond line', side: 'current', line: 3, location: 'current', resolved: false }; }

test('native tree registration survives the cached legacy Webview descriptor', () => {
  const { provider, tree } = fixture();
  try {
    assert.equal(viewDescriptors.get('legacy.webview').type, 'webview');
    assert.notEqual(tree.id, 'legacy.webview');
    assert.equal(manifest.contributes.views.localdiffreview.find(view => view.id === tree.id)?.type, 'tree');
    assert.ok(manifest.activationEvents.includes('onView:' + tree.id));
    assert.ok(manifest.contributes.viewsWelcome.every(welcome => welcome.view === tree.id));
    for (const menu of ['view/title', 'view/item/context']) {
      assert.ok(manifest.contributes.menus[menu].every(item => item.when.includes('view == ' + tree.id)));
    }
  } finally { provider.dispose(); }
});

test('native trailing badges show only file status while comments remain expandable child nodes', () => {
  const { provider, tree } = fixture();
  try {
    const first = { path: 'a.ts', status: 'M', reviewed: false, comments: [] };
    const second = { path: 'src/'.repeat(60) + 'b.ts', status: 'A', reviewed: false,
      comments: Array.from({ length: 12 }, (_, index) => comment('id-' + index)) };
    const state = { sessionId: 'session', baseLabel: 'HEAD', files: [first, second] };
    provider.update(state);
    const [a, b] = provider.getChildren();
    const firstRow = provider.getTreeItem(a), secondRow = provider.getTreeItem(b);
    assert.equal(firstRow.label, 'a.ts');
    assert.equal(secondRow.label, 'b.ts');
    assert.equal(firstRow.description, undefined, 'no duplicated M after the name');
    assert.equal(firstRow.resourceUri.path, '/repo/a.ts');
    assert.equal(firstRow.resourceUri.scheme, 'localdiffreview', 'do not involve Git decoration providers on checkbox updates');
    assert.equal(provider.provideFileDecoration(firstRow.resourceUri).badge, 'M');
    assert.equal(provider.provideFileDecoration(secondRow.resourceUri).badge, 'A');
    assert.equal(provider.provideFileDecoration(secondRow.resourceUri).color.id, 'gitDecoration.addedResourceForeground');
    assert.equal(provider.getChildren(b).length, 12);
    assert.equal(firstRow.checkboxState.state, vscode.TreeItemCheckboxState.Unchecked);
    assert.equal(firstRow.collapsibleState, vscode.TreeItemCollapsibleState.None);
    assert.equal(secondRow.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
    assert.equal(tree.options.manageCheckboxStateManually, true);
    assert.equal(tree.description, 'HEAD → workspace');
    second.comments.forEach(note => { note.resolved = true; });
    provider.update(state);
    assert.equal(provider.getChildren()[0], a, 'row objects remain stable across comment changes');
    assert.equal(provider.getTreeItem(a).label, 'a.ts');
    assert.equal(provider.getTreeItem(b).label, 'b.ts');
    assert.equal(provider.provideFileDecoration(secondRow.resourceUri).color.id, 'gitDecoration.addedResourceForeground');
    assert.equal(provider.provideFileDecoration(secondRow.resourceUri).badge, 'A');
    assert.ok(provider.getChildren(b).every(node => provider.getTreeItem(node).description.includes('resolved')));
    assert.equal(provider.provideFileDecoration(secondRow.resourceUri.with({ scheme: 'file' })), undefined,
      'review decorations must not leak into Explorer or normal editor tabs');
    second.comments.push(comment('open-again'));
    provider.update(state);
    assert.equal(provider.provideFileDecoration(secondRow.resourceUri).color.id, 'gitDecoration.addedResourceForeground',
      'reopening comments must not change the file color');
    second.comments = [];
    provider.update(state);
    assert.equal(provider.provideFileDecoration(secondRow.resourceUri).badge, 'A');
    assert.equal(provider.getTreeItem(b).collapsibleState, vscode.TreeItemCollapsibleState.None);
    second.status = '';
    second.comments = [comment('comment-only')];
    provider.update(state);
    assert.equal(provider.provideFileDecoration(secondRow.resourceUri), undefined, 'comments alone produce no decoration');
    assert.equal(provider.getTreeItem(b).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
    assert.equal(provider.getChildren(b).length, 1);
  } finally { provider.dispose(); }
});

test('native checkbox and comment nodes preserve identity and route actions with their review session', async () => {
  const { provider, tree, actions } = fixture();
  try {
    const note = comment('saved-id');
    const file = { path: 'a.ts', status: 'M', reviewed: false, comments: [note] };
    const state = { sessionId: 'session', baseLabel: 'HEAD', files: [file] };
    provider.update(state);
    const [fileNode] = provider.getChildren();
    const [commentNode] = provider.getChildren(fileNode);
    const fileId = provider.getTreeItem(fileNode).id, commentId = provider.getTreeItem(commentNode).id;
    assert.equal(provider.getParent(commentNode), fileNode);
    assert.equal(provider.getTreeItem(commentNode).checkboxState, undefined, 'comments have no reviewed checkbox');
    await tree.changeCheckbox([[fileNode, vscode.TreeItemCheckboxState.Checked], [commentNode, vscode.TreeItemCheckboxState.Checked]]);
    assert.deepEqual(actions, [{ type: 'setReviewed', sessionId: 'session', path: 'a.ts', reviewed: true }]);
    file.reviewed = true;
    note.resolved = true;
    provider.update(state);
    assert.equal(provider.getChildren(fileNode)[0], commentNode);
    assert.equal(provider.getTreeItem(fileNode).id, fileId);
    assert.equal(provider.getTreeItem(commentNode).id, commentId);
    assert.equal(provider.getTreeItem(fileNode).checkboxState.state, vscode.TreeItemCheckboxState.Checked);
    assert.equal(provider.getTreeItem(fileNode).label, 'a.ts');
    assert.equal(provider.provideFileDecoration(provider.getTreeItem(fileNode).resourceUri).color.id,
      'gitDecoration.modifiedResourceForeground');
    assert.match(provider.getTreeItem(commentNode).description, /resolved/);
    assert.equal(provider.getTreeItem(commentNode).contextValue, 'reviewComment');
    assert.deepEqual(provider.getTreeItem(commentNode).command.arguments,
      [{ type: 'openComment', sessionId: 'session', id: 'saved-id' }]);
    provider.update({ ...state, sessionId: 'other-session' });
    assert.notEqual(provider.getTreeItem(provider.getChildren()[0]).id, fileId, 'different bases have separate row IDs');
  } finally { provider.dispose(); }
});

test('checkbox changes refresh just one row without invalidating file decorations', () => {
  const { provider } = fixture();
  try {
    provider.update({ sessionId: 'session', files: [
      { path: 'a.ts', status: 'M', reviewed: false, comments: [comment('id')] },
      { path: 'b.ts', status: 'D', reviewed: false, comments: [] }
    ] });
    const [a, b] = provider.getChildren();
    const rowEvents = [], decorationEvents = [];
    provider.onDidChangeTreeData(node => rowEvents.push(node));
    provider.onDidChangeFileDecorations(uris => decorationEvents.push(uris));
    const badge = provider.provideFileDecoration(provider.getTreeItem(a).resourceUri);
    provider.setReviewed('session', 'a.ts', true);
    assert.deepEqual(rowEvents, [a]);
    assert.deepEqual(decorationEvents, []);
    assert.equal(provider.getTreeItem(a).checkboxState.state, vscode.TreeItemCheckboxState.Checked);
    assert.equal(provider.getTreeItem(b).checkboxState.state, vscode.TreeItemCheckboxState.Unchecked);
    assert.equal(provider.provideFileDecoration(provider.getTreeItem(a).resourceUri), badge);
    provider.setReviewed('session', 'a.ts', true);
    provider.setReviewed('stale-session', 'a.ts', false);
    assert.deepEqual(rowEvents, [a], 'no-op and stale updates emit nothing');
  } finally { provider.dispose(); }
});

test('decoration invalidation is scoped to changed resources and clears removed or switched reviews', () => {
  const { provider } = fixture();
  try {
    const note = comment('id');
    const state = { sessionId: 'session', files: [{ path: 'a.ts', status: 'M', reviewed: false, comments: [note] }] };
    provider.update(state);
    const oldUri = provider.getTreeItem(provider.getChildren()[0]).resourceUri;
    const events = [];
    provider.onDidChangeFileDecorations(uris => events.push(uris));
    provider.update(state);
    assert.deepEqual(events, [], 'an unchanged scan does not invalidate decoration caches');
    note.resolved = true;
    provider.update(state);
    assert.deepEqual(events, [], 'comment resolution must not invalidate file-status decorations');
    state.files[0].status = 'D';
    provider.update(state);
    assert.deepEqual(events.pop().map(uri => uri.toString()), [oldUri.toString()]);
    assert.equal(provider.provideFileDecoration(oldUri).badge, 'D');
    provider.update({ ...state, sessionId: 'other-session' });
    const newUri = provider.getTreeItem(provider.getChildren()[0]).resourceUri;
    assert.equal(events.pop().length, 2, 'old and new session resources are invalidated');
    assert.equal(provider.provideFileDecoration(oldUri), undefined);
    assert.equal(provider.provideFileDecoration(newUri).color.id, 'gitDecoration.deletedResourceForeground');
    provider.update({ files: [] });
    assert.deepEqual(events.pop().map(uri => uri.toString()), [newUri.toString()]);
    assert.equal(provider.provideFileDecoration(newUri), undefined);
  } finally { provider.dispose(); }
});
