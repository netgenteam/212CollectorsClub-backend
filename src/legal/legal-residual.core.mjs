// Story 19.3a (AD-90): residual-marker guard for publication. Pure, O(n),
// no regex over unbounded input. It looks at the text the PUBLIC will read
// (the Markdown AST text pieces collected by `legal-markdown.worker.mjs`, so
// entities, `\[` escapes, `>` prefixes, emphasis and link syntax are already
// gone), normalises it, and reports:
//   - 'marker': any `[[` or `]]` left (whitespace between the two brackets
//     allowed). There is no legitimate use of them in these texts. Single
//     brackets, `[a](b)` links and `[a][b]` references never contain them
//     in the visible text, so they pass; `[[a](b)]` is a bracketed link
//     whose visible text is `[a]` and also passes.
//   - 'notice': the seeded "Plantilla — revisar con un abogado antes de
//     publicar" notice, however it is dashed, spaced, wrapped, split across
//     lines/cells/links or disguised with invisible chars or lookalike letters.
// Plain ESM JavaScript for the same reason as the worker (see its header).

export const MAX_RESIDUALS = 200;
const NOTICE_FULL = 'plantilla revisar con un abogado antes de publicar';
// Second, independent signal: survives a disguised first word ("Plаntilla").
const NOTICE_PARTIAL = 'revisar con un abogado antes de publicar';

// Zero-width, soft hyphen, bidi marks, BOM, tags (\p{Cf}), CGJ, variation selectors.
const INVISIBLE = /[\p{Cf}\u034F\uFE00-\uFE0F]/u;
const INVISIBLE_ALL = /[\p{Cf}\u034F\uFE00-\uFE0F]+/gu;
const NON_ASCII = /[^\x00-\x7f]/;
const NON_WORD_ASCII = /[^a-z0-9]+/g;
const NON_WORD = /[^\p{L}\p{N}]+/gu;
const MARKS = /\p{M}/gu;

// Basic confusables (lower-case, applied after lower-casing): Cyrillic, Greek
// and Latin-extended letters that look like a Latin one. Not exhaustive on
// purpose; the partial phrase is the second line of defence.
const CONFUSABLE = new Map(
  Object.entries({
    а: 'a',
    е: 'e',
    о: 'o',
    р: 'p',
    с: 'c',
    у: 'y',
    х: 'x',
    і: 'i',
    ј: 'j',
    ѕ: 's',
    ԁ: 'd',
    ԛ: 'q',
    ԝ: 'w',
    һ: 'h',
    к: 'k',
    м: 'm',
    н: 'h',
    т: 't',
    в: 'b',
    ь: 'b',
    ӏ: 'l',
    ο: 'o',
    α: 'a',
    ι: 'i',
    ν: 'v',
    ρ: 'p',
    υ: 'u',
    ε: 'e',
    κ: 'k',
    τ: 't',
    χ: 'x',
    ɑ: 'a',
    ı: 'i',
    ɡ: 'g',
    ǀ: 'l',
    ⅼ: 'l',
  }),
);

const CONFUSABLE_RE = new RegExp(`[${[...CONFUSABLE.keys()].join('')}]`, 'gu');

function lineAt(offs, lines, off) {
  let lo = 0;
  let hi = offs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offs[mid] <= off) lo = mid;
    else hi = mid - 1;
  }
  return lines[lo] ?? 1;
}

/**
 * @param {Array<[string, number]>} pieces visible text pieces, document order,
 *   with the 1-based source line where each piece starts.
 * @returns {Array<['marker'|'notice', string, number]>} [kind, token, line]
 */
export function findResiduals(pieces) {
  const bOut = []; // bracket view: visible text, invisibles removed
  const nOut = []; // notice view: skeleton (see below)
  let bLen = 0;
  let nLen = 0;
  let nLast = ' ';
  const bOff = [0];
  const bLine = [1];
  const nOff = [0];
  const nLine = [1];

  for (const [raw, line0] of pieces) {
    let t = raw.includes('\r') ? raw.replace(/\r\n?/g, '\n') : raw;
    if (NON_ASCII.test(t)) {
      t = t.normalize('NFKC');
      if (INVISIBLE.test(t)) t = t.replace(INVISIBLE_ALL, '');
    }
    // bracket view: the text as is, with a (offset, line) mark per line start.
    bOut.push(t);
    let line = line0;
    bOff.push(bLen);
    bLine.push(line);
    for (let i = t.indexOf('\n'); i !== -1; i = t.indexOf('\n', i + 1)) {
      line++;
      bOff.push(bLen + i + 1);
      bLine.push(line);
    }
    bLen += t.length;

    // notice view, line by line (so offsets map back to source lines): lower
    // case, no diacritics, lookalike letters mapped to Latin, and every run
    // of non letters/digits (dashes of any kind, spaces, punctuation) is ONE
    // space. A line break separates words; adjacent inline pieces do not.
    line = line0;
    let from = 0;
    for (;;) {
      const nl = t.indexOf('\n', from);
      const seg = nl === -1 ? t.slice(from) : t.slice(from, nl);
      let k = seg.toLowerCase();
      if (NON_ASCII.test(k)) {
        k = k
          .normalize('NFD')
          .replace(MARKS, '')
          .replace(CONFUSABLE_RE, (c) => CONFUSABLE.get(c))
          .replace(NON_WORD, ' ');
      } else {
        k = k.replace(NON_WORD_ASCII, ' ');
      }
      if (k !== '') {
        if (k[0] === ' ' && nLast === ' ') k = k.slice(1);
        if (k !== '') {
          nOff.push(nLen);
          nLine.push(line);
          nOut.push(k);
          nLen += k.length;
          nLast = k[k.length - 1];
        }
      }
      if (nl === -1) break;
      if (nLast !== ' ') {
        nOut.push(' ');
        nLen += 1;
        nLast = ' ';
      }
      line++;
      from = nl + 1;
    }
  }

  const out = [];
  const b = bOut.join('');
  const n = nOut.join('');

  const re = /\[\s*\[|\]\s*\]/g;
  for (let m = re.exec(b); m && out.length < MAX_RESIDUALS; m = re.exec(b)) {
    const line = lineAt(bOff, bLine, m.index);
    let token = m[0].replace(/\s+/g, '');
    if (token === '[[') {
      const rest = b.slice(m.index + m[0].length, m.index + m[0].length + 90);
      const close = /\]\s*\]/.exec(rest);
      if (close) {
        const full = b.slice(
          m.index,
          m.index + m[0].length + close.index + close[0].length,
        );
        token = full.replace(/\s+/g, ' ');
        re.lastIndex = m.index + full.length;
      }
    }
    out.push(['marker', token, line]);
  }

  let at = n.indexOf(NOTICE_FULL);
  if (at === -1) at = n.indexOf(NOTICE_PARTIAL);
  if (at !== -1) out.push(['notice', '', lineAt(nOff, nLine, at)]);
  return out;
}
