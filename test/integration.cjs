const assert = require('node:assert/strict');
const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

async function eventually(action, label, deadline = 20000) {
  const start = Date.now();
  let error;
  do {
    try { return await action(); } catch (e) { error = e; }
    await new Promise(r => setTimeout(r, 200));
  } while (Date.now() - start < deadline);
  throw new Error(label + ': ' + error?.message);
}
exports.run = async () => {
  const root = vscode.workspace.workspaceFolders[0].uri;
  const extension = vscode.extensions.getExtension('localreview.diff-review');
  assert.ok(extension, 'extension is discovered');
  const app = await extension.activate();
  await app.start('HEAD', root);
  assert.equal(app.session.baseLabel, 'HEAD');
  assert.ok(app.changedFiles.find(f => f.path === 'main.ts'));
  const main = vscode.Uri.joinPath(root, 'main.ts');
  await app.openDiff('main.ts');
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  assert.ok(tab.input instanceof vscode.TabInputTextDiff, 'uses native text diff');
  assert.equal(tab.input.modified.toString(), main.toString(), 'modified side is the actual file URI');
  assert.equal(tab.input.original.scheme, 'diff-review-base');
  const baseDoc = await vscode.workspace.openTextDocument(tab.input.original);
  assert.match(baseDoc.getText(), /world/);
  assert.equal(baseDoc.languageId, 'typescript', 'baseline has language syntax highlighting');

  const tsExtension = vscode.extensions.getExtension('vscode.typescript-language-features');
  if (tsExtension) { await tsExtension.activate(); }
  await vscode.workspace.openTextDocument(main);
  const position = new vscode.Position(1, 16); // greet identifier in the modified file
  await eventually(async () => {
    const locations = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', main, position);
    assert.ok(locations?.some(l => (l.targetUri ?? l.uri).fsPath.endsWith('helper.ts')), 'cross-file definition works on the modified diff resource');
    return locations;
  }, 'language definition');
  await eventually(async () => {
    const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', main, position);
    assert.ok(hovers?.length, 'hover works on the modified diff resource');
  }, 'language hover');

  const comment = await app.addNote(main, new vscode.Range(1, 0, 2, 0), 'Check the argument.\nKeep this multiline.');
  assert.equal(comment.anchor.end, 1, 'selection ending at the next line excludes that line');
  assert.equal(app.threads.get(comment.id).comments.length, 1, 'native inline thread exists');
  const leftComment = await app.addNote(tab.input.original, new vscode.Range(1, 0, 1, 10), 'Baseline comment');
  assert.equal(leftComment.side, 'base');
  const draft = app.controller.createCommentThread(main, new vscode.Range(1, 0, 1, 0), []);
  await app.reply({ thread: draft, text: 'Added through native gutter reply' });
  assert.equal(app.session.comments.length, 3);
  const submitted = app.session.comments.at(-1);
  assert.equal(app.threads.get(submitted.id), draft, 'native draft becomes the saved thread');
  assert.equal(draft.comments[0].body, 'Added through native gutter reply');

  await app.editComment(comment);
  let editing = app.threads.get(comment.id).comments[0];
  assert.equal(editing.mode, vscode.CommentMode.Editing);
  await app.saveEdit({ ...editing, body: 'Edited comment\nSecond line' });
  assert.equal(comment.body, 'Edited comment\nSecond line');
  await app.editComment(comment);
  await app.cancelEdit(app.threads.get(comment.id).comments[0]);
  assert.equal(app.threads.get(comment.id).comments[0].mode, vscode.CommentMode.Preview);

  const edit = new vscode.WorkspaceEdit();
  edit.insert(main, new vscode.Position(0, 0), '// new prefix\n');
  assert.equal(await vscode.workspace.applyEdit(edit), true);
  await app.refresh();
  let data = await app.buildExport();
  assert.equal(data.comments.find(n => n.comment.id === comment.id).location.status, 'moved');
  assert.equal(data.comments.find(n => n.comment.id === comment.id).location.start, 2);
  assert.equal(data.comments.find(n => n.comment.id === leftComment.id).location.start, 1);
  const replace = new vscode.WorkspaceEdit();
  replace.replace(main, new vscode.Range(2, 0, 2, 100), 'const answer = greet("edited");');
  await vscode.workspace.applyEdit(replace);
  await app.refresh();
  data = await app.buildExport();
  assert.equal(data.comments.find(n => n.comment.id === comment.id).location.status, 'outdated');
  assert.equal(app.threads.has(comment.id), false, 'stale comment is not attached to an incorrect line');
  const doc = await vscode.workspace.openTextDocument(main);
  const editor = await vscode.window.showTextDocument(doc);
  editor.selection = new vscode.Selection(2, 0, 2, 20);
  await app.reanchor(comment);
  assert.equal((await app.buildExport()).comments.find(n => n.comment.id === comment.id).location.status, 'current');
  await app.toggleResolved(comment);
  assert.equal(comment.resolved, true);

  // Unsaved edits in a file with no on-disk changes must appear in the tree.
  const helper = vscode.Uri.joinPath(root, 'helper.ts');
  await vscode.workspace.openTextDocument(helper);
  const dirtyEdit = new vscode.WorkspaceEdit();
  dirtyEdit.insert(helper, new vscode.Position(0, 0), '// dirty-only\n');
  await vscode.workspace.applyEdit(dirtyEdit);
  await app.refresh();
  assert.ok(app.changedFiles.find(f => f.path === 'helper.ts'));

  await app.openDiff('gone.ts');
  const deletedTab = vscode.window.tabGroups.activeTabGroup.activeTab;
  assert.equal((await vscode.workspace.openTextDocument(deletedTab.input.modified)).getText(), '');
  assert.match((await vscode.workspace.openTextDocument(deletedTab.input.original)).getText(), /removed/);
  await app.openDiff('new.ts');
  const addedTab = vscode.window.tabGroups.activeTabGroup.activeTab;
  assert.equal((await vscode.workspace.openTextDocument(addedTab.input.original)).getText(), '');
  assert.equal(addedTab.input.modified.scheme, 'file');

  const reviewCopy = await app.copyReview();
  assert.equal(await vscode.env.clipboard.readText(), reviewCopy);
  assert.match(reviewCopy, /Baseline comment/);
  assert.doesNotMatch(reviewCopy, /Edited comment/);
  await app.discard(leftComment);
  assert.equal(app.session.comments.length, 2);
  // Memento stores an actual copy, surviving reactivation/new app instance.
  const stored = app.context.workspaceState.get('reviews.v1');
  assert.equal(stored.sessions.find(s => s.id === app.session.id).comments.length, 2);
  const { ReviewExtension } = require('../dist/extension');
  const ctx = app.context;
  app.dispose();
  const restored = new ReviewExtension(ctx);
  await restored.initialize();
  assert.equal(restored.session.comments.length, 2);
  assert.equal(restored.session.baseSha, stored.sessions[0].baseSha);
  restored.dispose();
  const results = {
    vscode: vscode.version, passed: [
      'native diff with actual workspace URI', 'baseline syntax highlighting',
      'TypeScript cross-file definition and hover', 'current and baseline inline threads',
      'native gutter reply and multiline edit', 'safe moved/outdated anchors and reattachment',
      'unsaved buffers', 'added/deleted file diffs', 'clipboard export and resolved filtering',
      'comment deletion and persisted session restoration'
    ]
  };
  await fs.writeFile(process.env.DIFF_REVIEW_TEST_RESULT, JSON.stringify(results, null, 2));
  console.log('DIFF REVIEW INTEGRATION PASSED', JSON.stringify(results));
};
