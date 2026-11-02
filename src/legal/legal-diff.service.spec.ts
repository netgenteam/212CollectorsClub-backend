import { diffMarkdown } from './legal-diff.core.mjs';

const nums = (n: number, from = 1) =>
  Array.from({ length: n }, (_, i) => `l${from + i}`);
const text = (lines: string[]) => lines.join('\n') + '\n';

describe('diffMarkdown', () => {
  it('identical texts: no hunks, zero stats', () => {
    expect(diffMarkdown(text(nums(10)), text(nums(10)))).toEqual({
      stats: { added: 0, removed: 0 },
      hunks: [],
    });
  });

  it('only the changed lines, plus 3 lines of context at each edge', () => {
    const a = nums(20);
    const b = [...a];
    b[9] = 'l10 CAMBIADA';
    const d = diffMarkdown(text(a), text(b));
    expect(d.stats).toEqual({ added: 1, removed: 1 });
    expect(d.hunks).toEqual([
      { type: 'context', lines: ['l7', 'l8', 'l9'], oldStart: 7, newStart: 7 },
      { type: 'removed', lines: ['l10'], oldStart: 10, newStart: 10 },
      { type: 'added', lines: ['l10 CAMBIADA'], oldStart: 11, newStart: 10 },
      {
        type: 'context',
        lines: ['l11', 'l12', 'l13'],
        oldStart: 11,
        newStart: 11,
      },
    ]);
  });

  it('a long unchanged stretch between two changes is cut to 3 + 3 lines', () => {
    const a = nums(30);
    const b = [...a];
    b[1] = 'X2';
    b[27] = 'X28';
    const d = diffMarkdown(text(a), text(b));
    const mid = d.hunks.filter((h) => h.type === 'context');
    expect(mid.map((h) => h.lines)).toEqual([
      ['l1'], // leading context (only one line precedes the change)
      ['l3', 'l4', 'l5'],
      ['l25', 'l26', 'l27'],
      ['l29', 'l30'],
    ]);
    expect(d.stats).toEqual({ added: 2, removed: 2 });
  });

  it('additions at the end and removals at the start', () => {
    const d = diffMarkdown(text(['a', 'b']), text(['b', 'c']));
    expect(d.hunks.filter((h) => h.type === 'removed')[0].lines).toEqual(['a']);
    expect(d.hunks.filter((h) => h.type === 'added')[0].lines).toEqual(['c']);
  });

  it('CRLF and a missing final newline are not changes', () => {
    expect(diffMarkdown('a\r\nb\r\n', 'a\nb')).toEqual({
      stats: { added: 0, removed: 0 },
      hunks: [],
    });
  });

  it('from an empty text everything is added; to an empty one everything is removed', () => {
    expect(diffMarkdown('', 'a\nb\n')).toMatchObject({
      stats: { added: 2, removed: 0 },
      hunks: [{ type: 'added', lines: ['a', 'b'], oldStart: 1, newStart: 1 }],
    });
    expect(diffMarkdown('a\n', '')).toMatchObject({
      stats: { added: 0, removed: 1 },
    });
  });
});
