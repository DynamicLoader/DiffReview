import { createHash, randomUUID } from 'node:crypto';

export type Side = 'base' | 'current';
export type AnchorStatus = 'current' | 'moved' | 'outdated' | 'ambiguous';
export interface LineRange { start: number; end: number }
export interface Anchor extends LineRange {
  lines: string[];
  before: string[];
  after: string[];
  hash: string;
}
export interface ReviewComment {
  id: string;
  path: string;
  basePath: string;
  side: Side;
  body: string;
  resolved: boolean;
  createdAt: string;
  updatedAt: string;
  anchor: Anchor;
}
export interface Change {
  path: string;
  basePath: string;
  status: string;
}
export interface ReviewSession {
  id: string;
  rootUri: string;
  rootPath: string;
  baseSha: string;
  baseLabel: string;
  headAtStart: string;
  createdAt: string;
  comments: ReviewComment[];
  reviewedFiles?: string[];
}
export interface ReviewStore { version: 1; activeId?: string; sessions: ReviewSession[] }
export interface LocatedAnchor extends LineRange { status: AnchorStatus }

export function hash(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
}
export function linesOf(text: string): string[] { return text.replace(/\r\n/g, '\n').split('\n'); }
export function captureAnchor(text: string, range: LineRange, context = 3): Anchor {
  const lines = linesOf(text);
  const start = Math.min(Math.max(0, range.start), lines.length - 1);
  const end = Math.min(Math.max(start, range.end), lines.length - 1);
  return { start, end, lines: lines.slice(start, end + 1),
    before: lines.slice(Math.max(0, start - context), start),
    after: lines.slice(end + 1, end + 1 + context), hash: hash(text) };
}
export function locateAnchor(anchor: Anchor, text: string): LocatedAnchor {
  const lines = linesOf(text);
  const fallback = { start: Math.min(anchor.start, lines.length - 1),
    end: Math.min(anchor.end, lines.length - 1) };
  if (hash(text) === anchor.hash) { return { ...fallback, status: 'current' }; }
  const candidates: { start: number; score: number }[] = [];
  for (let i = 0; i + anchor.lines.length <= lines.length; i++) {
    if (!anchor.lines.every((line, j) => line === lines[i + j])) { continue; }
    let score = 0;
    for (let j = 1; j <= anchor.before.length; j++) {
      if (lines[i - j] !== anchor.before[anchor.before.length - j]) { break; }
      score++;
    }
    for (let j = 0; j < anchor.after.length; j++) {
      if (lines[i + anchor.lines.length + j] !== anchor.after[j]) { break; }
      score++;
    }
    candidates.push({ start: i, score });
  }
  if (!candidates.length) { return { ...fallback, status: 'outdated' }; }
  candidates.sort((a, b) => b.score - a.score);
  if (candidates.length > 1 && candidates[0].score === candidates[1].score) {
    return { ...fallback, status: 'ambiguous' };
  }
  const start = candidates[0].start;
  return { start, end: start + anchor.lines.length - 1, status: start === anchor.start ? 'current' : 'moved' };
}

export function newSession(fields: Omit<ReviewSession, 'id' | 'createdAt' | 'comments' | 'reviewedFiles'>): ReviewSession {
  return { ...fields, id: randomUUID(), createdAt: new Date().toISOString(), comments: [], reviewedFiles: [] };
}
export function makeComment(fields: Omit<ReviewComment, 'id' | 'createdAt' | 'updatedAt' | 'resolved'>): ReviewComment {
  const now = new Date().toISOString();
  return { ...fields, id: randomUUID(), createdAt: now, updatedAt: now, resolved: false };
}
export function parseNameStatus(output: string): Change[] {
  const fields = output.split('\0');
  const changes: Change[] = [];
  for (let i = 0; i < fields.length && fields[i];) {
    const status = fields[i++];
    const first = fields[i++];
    if (first === undefined) { throw new Error('Incomplete Git name-status output'); }
    const path = status[0] === 'R' || status[0] === 'C' ? fields[i++] : first;
    if (path === undefined) { throw new Error('Incomplete Git rename output'); }
    changes.push({ path, basePath: first, status: status[0] });
  }
  return changes;
}
export function fenced(text: string, language = ''): string {
  const longest = Math.max(2, ...Array.from(text.matchAll(/`+/g), m => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return fence + language + '\n' + text + '\n' + fence;
}
