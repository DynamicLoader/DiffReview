import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { Change, parseNameStatus } from './model';

export function runGit(cwd: string, args: string[], executable = 'git'): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, ['--no-optional-locks', '-c', 'core.quotepath=false', ...args],
      { cwd, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8', timeout: 30000,
        windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (error, stdout, stderr) => {
        if (error) { reject(new Error((stderr || error.message).trim())); }
        else { resolve(stdout); }
      });
  });
}
export async function resolveCommit(root: string, ref: string, git = 'git'): Promise<string> {
  return (await runGit(root, ['rev-parse', '--verify', '--end-of-options', ref + '^{commit}'], git)).trim();
}
export async function readBase(root: string, sha: string, file: string, git = 'git'): Promise<string> {
  if (!/^[a-f0-9]{40,64}$/.test(sha)) { throw new Error('Invalid baseline commit'); }
  return runGit(root, ['show', sha + ':' + file], git);
}
export async function listChanges(root: string, sha: string, git = 'git'): Promise<Change[]> {
  const [tracked, untracked] = await Promise.all([
    runGit(root, ['diff', '--no-ext-diff', '--name-status', '-z', '--find-renames', sha, '--'], git),
    runGit(root, ['ls-files', '--others', '--exclude-standard', '-z'], git)
  ]);
  const result = parseNameStatus(tracked);
  const seen = new Set(result.map(c => c.path));
  for (const file of untracked.split('\0').filter(Boolean)) {
    if (!seen.has(file)) { result.push({ path: file, basePath: file, status: 'U' }); }
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
export function relativeFile(root: string, file: string): string | undefined {
  const relative = path.relative(root, file);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) { return undefined; }
  return relative.split(path.sep).join('/');
}
export async function baselineChoices(root: string, git = 'git'): Promise<{ label: string; ref: string; description: string }[]> {
  const [localRefs, log] = await Promise.all([
    runGit(root, ['for-each-ref', '--format=%(refname:short)%09%(objectname:short)%09%(upstream)', 'refs/heads'], git),
    runGit(root, ['log', '-30', '--format=%H%x09%h%x09%s'], git)
  ]);
  const choices = [{ label: 'HEAD', ref: 'HEAD', description: 'Current commit → workspace' }];
  const trackedRemoteRefs = new Set<string>();
  for (const line of localRefs.trim().split('\n').filter(Boolean)) {
    const [ref, sha, upstream] = line.split('\t');
    choices.push({ label: ref, ref, description: sha });
    if (upstream?.startsWith('refs/remotes/')) { trackedRemoteRefs.add(upstream); }
  }
  if (trackedRemoteRefs.size) {
    const trackedRefs = await runGit(root,
      ['for-each-ref', '--format=%(refname)%09%(refname:short)%09%(objectname:short)', ...trackedRemoteRefs], git);
    for (const line of trackedRefs.trim().split('\n').filter(Boolean)) {
      const [fullRef, ref, sha] = line.split('\t');
      if (trackedRemoteRefs.has(fullRef)) { choices.push({ label: ref, ref, description: sha }); }
    }
  }
  for (const line of log.trim().split('\n').filter(Boolean)) {
    const [ref, short, ...subject] = line.split('\t');
    choices.push({ label: short, ref, description: subject.join('\t') });
  }
  return choices;
}
