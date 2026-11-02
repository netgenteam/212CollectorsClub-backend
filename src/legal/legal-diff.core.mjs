// Story 19.2 (QA D1): the pure line diff. It lives in plain JS because it runs
// INSIDE the worker pool (`legal-markdown.worker.mjs`, job type 'diff'), never
// on the API event loop: jsdiff is O(N*D) and takes seconds on two 200 KB texts
// whose lines all differ. The unit tests import this same module directly.
import { diffLines } from 'diff';

export const DIFF_CONTEXT_LINES = 3;

const toLines = (s) => {
  const t = s.replace(/\r\n?/g, '\n');
  const lines = t.split('\n');
  if (lines[lines.length - 1] === '') lines.pop(); // trailing newline is not a line
  return lines;
};

/**
 * Pure line diff (jsdiff `diffLines`) trimmed to `DIFF_CONTEXT_LINES` of
 * context. Each hunk is a RUN of one type with the 1-based line where it
 * starts in the old and the new text. Unchanged stretches longer than twice
 * the context are cut (the gap is implicit in the `oldStart`/`newStart` jump).
 */
export function diffMarkdown(from, to) {
  // Normalize the end of file so "a" vs "a\n" is not reported as a change.
  const norm = (s) => {
    const l = toLines(s);
    return l.length > 0 ? l.join('\n') + '\n' : '';
  };
  const parts = diffLines(norm(from), norm(to));
  const runs = parts
    .map((p) => ({
      type: p.added ? 'added' : p.removed ? 'removed' : 'context',
      lines: toLines(p.value),
    }))
    .filter((r) => r.lines.length > 0);

  const hunks = [];
  const stats = { added: 0, removed: 0 };
  let oldLine = 1;
  let newLine = 1;
  runs.forEach((r, i) => {
    const start = { oldStart: oldLine, newStart: newLine };
    const n = r.lines.length;
    if (r.type === 'added') stats.added += n;
    if (r.type === 'removed') stats.removed += n;
    if (r.type !== 'added') oldLine += n;
    if (r.type !== 'removed') newLine += n;
    if (r.type !== 'context') {
      hunks.push({ type: r.type, lines: r.lines, ...start });
      return;
    }
    const first = i === 0;
    const last = i === runs.length - 1;
    if (first && last) return; // identical texts: nothing changed
    if (first || last) {
      const keep = r.lines.length > DIFF_CONTEXT_LINES ? DIFF_CONTEXT_LINES : n;
      if (first) {
        const skip = n - keep;
        hunks.push({
          type: 'context',
          lines: r.lines.slice(skip),
          oldStart: start.oldStart + skip,
          newStart: start.newStart + skip,
        });
      } else {
        hunks.push({
          type: 'context',
          lines: r.lines.slice(0, keep),
          ...start,
        });
      }
      return;
    }
    if (n <= 2 * DIFF_CONTEXT_LINES) {
      hunks.push({ type: 'context', lines: r.lines, ...start });
    } else {
      hunks.push({
        type: 'context',
        lines: r.lines.slice(0, DIFF_CONTEXT_LINES),
        ...start,
      });
      const skip = n - DIFF_CONTEXT_LINES;
      hunks.push({
        type: 'context',
        lines: r.lines.slice(skip),
        oldStart: start.oldStart + skip,
        newStart: start.newStart + skip,
      });
    }
  });
  return { stats, hunks };
}
