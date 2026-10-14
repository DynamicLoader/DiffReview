import { ReviewSession, ReviewComment, LocatedAnchor, fenced } from './model';

export interface CommentExport {
  comment: ReviewComment;
  location: LocatedAnchor;
  currentSnippet?: string;
  sourceHash?: string;
}
export interface ReviewExport {
  schemaVersion: 1;
  exportedAt: string;
  baseSha: string;
  baseLabel: string;
  headAtStart: string;
  currentHead: string;
  target: 'workspace (including unsaved buffers)';
  comments: CommentExport[];
}
export function exportData(session: ReviewSession, comments: CommentExport[], currentHead: string): ReviewExport {
  return { schemaVersion: 1, exportedAt: new Date().toISOString(), baseSha: session.baseSha,
    baseLabel: session.baseLabel, headAtStart: session.headAtStart, currentHead,
    target: 'workspace (including unsaved buffers)', comments };
}
export function markdownReview(data: ReviewExport, includeResolved = false): string {
  const notes = data.comments.filter(n => includeResolved || !n.comment.resolved);
  const out = [
    '# Code review',
    '',
    'Apply the following review comments to the current workspace. Check the quoted code before editing; line numbers may have changed.',
    '',
    '- Base: ' + data.baseSha + ' (' + data.baseLabel.replace(/[\r\n]/g, ' ') + ')',
    '- Current HEAD: ' + data.currentHead,
    '- Target: ' + data.target,
    '- Exported: ' + data.exportedAt,
    '- Comments: ' + notes.length,
    ''
  ];
  if (!notes.length) { out.push('No unresolved review comments.', ''); }
  for (const [i, note] of notes.entries()) {
    const c = note.comment;
    out.push('## ' + (i + 1) + '. ' + c.path.replace(/[\r\n]/g, ' '), '',
      '- Side: ' + c.side,
      '- Original lines: ' + (c.anchor.start + 1) + '–' + (c.anchor.end + 1),
      '- Current location: ' + note.location.status + ' (lines ' + (note.location.start + 1) + '–' + (note.location.end + 1) + ')',
      '- State: ' + (c.resolved ? 'resolved' : 'unresolved'),
      '- Comment ID: ' + c.id);
    if (c.basePath !== c.path) { out.push('- Baseline path: ' + c.basePath.replace(/[\r\n]/g, ' ')); }
    if (note.sourceHash) { out.push('- Source SHA-256: ' + note.sourceHash); }
    out.push('', '**Review comment**', '', c.body, '', '**Code when reviewed**', '',
      fenced([...c.anchor.before, ...c.anchor.lines, ...c.anchor.after].join('\n')), '');
    if (note.location.status === 'outdated' || note.location.status === 'ambiguous') {
      out.push('The anchor could not be confirmed. Find the intended code using the original excerpt; do not trust the displayed line numbers.', '');
    }
    if (note.currentSnippet !== undefined && note.currentSnippet !== [...c.anchor.before, ...c.anchor.lines, ...c.anchor.after].join('\n')) {
      out.push('**Code at export**', '', fenced(note.currentSnippet), '');
    }
  }
  return out.join('\n');
}
