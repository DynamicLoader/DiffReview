const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { captureAnchor, locateAnchor, parseNameStatus, hash, fenced } = require('../dist/model');
const { runGit, resolveCommit, readBase, listChanges, relativeFile, baselineChoices } = require('../dist/git');
const { exportData, markdownReview } = require('../dist/export');
const manifest = require('../package.json');

test('user-facing extension name is consistent across the manifest', () => {
  assert.equal(manifest.publisher + '.' + manifest.name, 'DynamicLoader.local-diff-review');
  assert.equal(manifest.displayName, 'Local Diff Review');
  assert.ok(manifest.contributes.commands.every(command => command.category === manifest.displayName));
  assert.equal(manifest.contributes.viewsContainers.activitybar[0].title, manifest.displayName);
  assert.equal(manifest.contributes.configuration.title, manifest.displayName);
  assert.equal(manifest.contributes.viewsContainers.activitybar[0].id, 'localdiffreview');
  assert.deepEqual(Object.keys(manifest.contributes.views), ['localdiffreview']);
  assert.ok(manifest.contributes.commands.every(command => command.command.startsWith('localdiffreview.')));
  assert.ok(Object.keys(manifest.contributes.configuration.properties).every(key => key.startsWith('localdiffreview.')));
  for (const items of Object.values(manifest.contributes.menus)) {
    assert.ok(items.every(item => item.command.startsWith('localdiffreview.')));
  }
});

test('extension package icon is a square PNG and the sidebar keeps its SVG icon', async () => {
  assert.equal(manifest.icon, 'media/review.png');
  const icon = await fs.readFile(path.resolve(__dirname, '..', manifest.icon));
  assert.deepEqual([...icon.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(icon.toString('ascii', 12, 16), 'IHDR');
  assert.equal(icon.readUInt32BE(16), 256);
  assert.equal(icon.readUInt32BE(20), 256);
  assert.equal(manifest.contributes.viewsContainers.activitybar[0].icon, 'media/review.svg');
});

test('source, scripts, docs and compiled output contain no retired extension identifiers', async () => {
  const root = path.resolve(__dirname, '..');
  // Build the retired spellings from parts so this assertion does not match its own source.
  const retired = new RegExp([
    '(?<!local-)' + ['diff', 'review'].join('-'),
    ['diff', 'Review'].join(''), ['diff', 'View'].join(''),
    '(?<!local)' + ['diff', 'view'].join(''), ['DIFF', 'REVIEW'].join('_'),
    '(?<!Local )' + ['Diff', 'Review'].join(' '),
    ['local', 'diff', 'view'].join(''), ['LOCAL', 'DIFF', 'VIEW'].join('')
  ].join('|'));
  async function check(relative) {
    const target = path.join(root, relative);
    const stat = await fs.stat(target);
    if (stat.isDirectory()) {
      for (const name of await fs.readdir(target)) { await check(path.join(relative, name)); }
    } else if (/\.(?:ts|cjs|js|json|map|md|svg)$/.test(relative) || !path.extname(relative)) {
      assert.doesNotMatch(await fs.readFile(target, 'utf8'), retired, relative);
    }
  }
  for (const relative of ['src', 'test', 'scripts', 'media', 'dist', 'README.md', 'TESTING.md', 'LICENSE',
    'package.json', 'package-lock.json', 'tsconfig.json', '.gitignore', '.vscodeignore']) { await check(relative); }
});

test('anchors follow an inserted prefix and return after undo', () => {
  const source = 'one\ntwo\nthree\nfour';
  const anchor = captureAnchor(source, { start: 1, end: 2 });
  assert.deepEqual(locateAnchor(anchor, 'new\n' + source), { start: 2, end: 3, status: 'moved' });
  assert.deepEqual(locateAnchor(anchor, source), { start: 1, end: 2, status: 'current' });
});
test('editing the quoted code marks it outdated', () => {
  const anchor = captureAnchor('one\ntarget\nthree', { start: 1, end: 1 });
  assert.equal(locateAnchor(anchor, 'one\nchanged\nthree').status, 'outdated');
});
test('duplicate excerpts with equal context do not silently pick the nearest', () => {
  const anchor = captureAnchor('before\nitem\nafter', { start: 1, end: 1 });
  assert.equal(locateAnchor(anchor, 'before\nitem\nafter\nbefore\nitem\nafter').status, 'ambiguous');
});
test('surrounding context disambiguates duplicates after a move', () => {
  const anchor = captureAnchor('A\nitem\nB', { start: 1, end: 1 });
  assert.deepEqual(locateAnchor(anchor, 'item\nother\nA\nitem\nB'), { start: 3, end: 3, status: 'moved' });
});
test('zero context remains conservative on duplicate matches', () => {
  const anchor = captureAnchor('item', { start: 0, end: 0 }, 0);
  assert.equal(locateAnchor(anchor, 'item\nitem').status, 'ambiguous');
});
test('CRLF and LF refer to the same code', () => {
  const anchor = captureAnchor('a\r\nb\r\nc', { start: 1, end: 1 });
  assert.equal(locateAnchor(anchor, 'a\nb\nc').status, 'current');
  assert.equal(hash('a\r\nb'), hash('a\nb'));
});
test('NUL-delimited Git changes retain unusual paths and rename pairs', () => {
  assert.deepEqual(parseNameStatus('M\0a b.ts\0R100\0old\t名.ts\0new\n名.ts\0D\0gone.ts\0'), [
    { path: 'a b.ts', basePath: 'a b.ts', status: 'M' },
    { path: 'new\n名.ts', basePath: 'old\t名.ts', status: 'R' },
    { path: 'gone.ts', basePath: 'gone.ts', status: 'D' }
  ]);
});
test('empty and truncated change lists are handled', () => {
  assert.deepEqual(parseNameStatus(''), []);
  assert.throws(() => parseNameStatus('R100\0a'), /Incomplete/);
});
test('repository escape paths are rejected', () => {
  assert.equal(relativeFile('/repo', '/repository/file'), undefined);
  assert.equal(relativeFile('/repo', '/repo/../outside'), undefined);
  assert.equal(relativeFile('/repo', '/repo/src/a.ts'), 'src/a.ts');
});
test('Markdown fences safely contain code with backticks', () => {
  assert.equal(fenced('before\n```\nafter'), '````\nbefore\n```\nafter\n````');
});
test('Markdown includes excerpts and stale anchors, with resolved filtering', () => {
  const comment = { id: 'id', path: 'file.ts', basePath: 'old.ts', side: 'current', body: 'Please validate this.',
    resolved: false, anchor: captureAnchor('before\nitem\nafter', { start: 1, end: 1 }), createdAt: 'now', updatedAt: 'now' };
  const session = { baseSha: 'a'.repeat(40), baseLabel: 'HEAD', headAtStart: 'b'.repeat(40) };
  const data = exportData(session, [{ comment, location: { start: 1, end: 1, status: 'outdated' } }], 'c'.repeat(40));
  assert.match(markdownReview(data), /Please validate this/);
  assert.match(markdownReview(data), /anchor could not be confirmed/);
  assert.match(markdownReview(data), /before\nitem\nafter/);
  assert.match(markdownReview(data), /Baseline path: old.ts/);
  comment.resolved = true;
  assert.doesNotMatch(markdownReview(data), /Please validate this/);
  assert.match(markdownReview(data, true), /Please validate this/);
});

let root;

test('recreated files override staged and committed deletions against the pinned baseline', async t => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'localdiffreview-restored-'));
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  await runGit(repo, ['init', '-q']);
  await runGit(repo, ['config', 'user.name', 'Test']);
  await runGit(repo, ['config', 'user.email', 'test@example.invalid']);
  await runGit(repo, ['config', 'core.autocrlf', 'false']);
  const file = 'restored 名.ts';
  await fs.writeFile(path.join(repo, file), 'baseline\n');
  await runGit(repo, ['add', '--all']);
  await runGit(repo, ['commit', '-qm', 'baseline']);
  const base = await resolveCommit(repo, 'HEAD');
  await runGit(repo, ['rm', '--', file]);
  for (const committed of [false, true]) {
    if (committed) { await runGit(repo, ['commit', '-qm', 'delete']); }
    assert.equal((await listChanges(repo, base)).find(c => c.path === file).status, 'D');
    await fs.writeFile(path.join(repo, file), 'recreated with changes\n');
    assert.deepEqual(await listChanges(repo, base), [{ path: file, basePath: file, status: 'M' }]);
    await fs.writeFile(path.join(repo, file), 'baseline\n');
    assert.deepEqual(await listChanges(repo, base), []);
    await fs.unlink(path.join(repo, file));
  }
});

after(async () => { if (root) { await fs.rm(root, { recursive: true, force: true }); } });
test('real Git repo: pinned base, staged, unstaged, rename, delete and untracked', async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'localdiffreview-git-'));
  await runGit(root, ['init', '-q']);
  await runGit(root, ['config', 'user.name', 'Local Diff Review Test']);
  await runGit(root, ['config', 'user.email', 'test@example.invalid']);
  for (const [name, content] of [['modify.ts', 'old\n'], ['rename 名.ts', 'same content\n'], ['delete.ts', 'gone\n'], ['staged.ts', 'before\n']]) {
    await fs.writeFile(path.join(root, name), content);
  }
  await runGit(root, ['add', '--all']);
  await runGit(root, ['commit', '-qm', 'baseline']);
  const sha = await resolveCommit(root, 'HEAD');
  await runGit(root, ['branch', 'local-topic']);
  await runGit(root, ['config', 'remote.origin.url', '.']);
  await runGit(root, ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);
  await runGit(root, ['update-ref', 'refs/remotes/origin/remote-topic', sha]);
  await runGit(root, ['update-ref', 'refs/remotes/origin/untracked-topic', sha]);
  await runGit(root, ['branch', '--set-upstream-to=origin/remote-topic', 'local-topic']);
  await runGit(root, ['tag', 'local-tag']);
  const choices = await baselineChoices(root);
  assert.ok(choices.some(choice => choice.ref === 'HEAD'));
  assert.ok(choices.some(choice => choice.ref === 'local-topic'));
  assert.ok(choices.some(choice => choice.ref === sha), 'recent commits remain available');
  assert.ok(choices.some(choice => choice.ref === 'origin/remote-topic'), 'tracked remote branch is included');
  assert.ok(!choices.some(choice => choice.ref === 'origin/untracked-topic'), 'untracked remote branch is excluded');
  assert.ok(!choices.some(choice => choice.ref === 'local-tag'), 'tags are excluded from automatic choices');
  assert.equal(await readBase(root, sha, 'modify.ts'), 'old\n');
  await fs.writeFile(path.join(root, 'modify.ts'), 'new\n');
  await runGit(root, ['mv', 'rename 名.ts', 'new 名.ts']);
  await fs.unlink(path.join(root, 'delete.ts'));
  await fs.writeFile(path.join(root, 'staged.ts'), 'after\n');
  await runGit(root, ['add', 'staged.ts']);
  const oddPath = 'untracked `touch BAD` $file.ts';
  await fs.writeFile(path.join(root, oddPath), 'new file');
  const changes = await listChanges(root, sha);
  assert.deepEqual(changes.find(c => c.path === 'new 名.ts'), { path: 'new 名.ts', basePath: 'rename 名.ts', status: 'R' });
  assert.equal(changes.find(c => c.path === 'modify.ts').status, 'M');
  assert.equal(changes.find(c => c.path === 'staged.ts').status, 'M');
  assert.equal(changes.find(c => c.path === 'delete.ts').status, 'D');
  assert.equal(changes.find(c => c.path === oddPath).status, 'U');
  await runGit(root, ['add', '--all']);
  await runGit(root, ['commit', '-qm', 'change']);
  assert.equal(await readBase(root, sha, 'modify.ts'), 'old\n');
  assert.equal((await listChanges(root, sha)).find(c => c.path === oddPath).status, 'A');
  assert.equal(await readBase(root, sha, 'rename 名.ts'), 'same content\n');
  assert.equal(await resolveCommit(root, 'HEAD~1'), sha);
  await assert.rejects(resolveCommit(root, '--help'));
  await assert.rejects(readBase(root, '--bad', 'modify.ts'), /Invalid baseline/);
  await assert.rejects(fs.stat(path.join(root, 'BAD')));
});
