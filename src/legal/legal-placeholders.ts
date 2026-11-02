/**
 * AD-90: tokens like `[[RAZON_SOCIAL]]` or `[[RAZÓN_SOCIAL]]` (any Unicode
 * upper-case letter, so accents and ñ count; combining marks allowed for the
 * decomposed form). Conservative: also matches inside code.
 */
const PLACEHOLDER_RE = /\[\[\p{Lu}[\p{Lu}\p{M}0-9_]{1,40}\]\]/gu;

export interface LegalPlaceholder {
  /** The literal match, brackets included (e.g. `[[RIF]]`). */
  token: string;
  /** 1-based line of the match (CRLF, LF and lone CR each end a line). */
  line: number;
}

/** Pure. Lower-case `[[x]]` is not a placeholder. Order of appearance. */
export function detectPlaceholders(md: string): LegalPlaceholder[] {
  const out: LegalPlaceholder[] = [];
  const re = new RegExp(PLACEHOLDER_RE.source, 'gu');
  let line = 1;
  let scanned = 0;
  for (const m of md.matchAll(re)) {
    const idx = m.index;
    const chunk = md.slice(scanned, idx);
    line += (chunk.match(/\r\n|\r|\n/g) ?? []).length;
    scanned = idx;
    out.push({ token: m[0], line });
  }
  return out;
}
