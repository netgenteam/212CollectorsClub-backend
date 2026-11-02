/** AD-90: tokens like `[[RAZON_SOCIAL]]`. Conservative: also matches inside code. */
const PLACEHOLDER_RE = /\[\[[A-Z][A-Z0-9_]{1,40}\]\]/g;

export interface LegalPlaceholder {
  /** The literal match, brackets included (e.g. `[[RIF]]`). */
  token: string;
  /** 1-based line of the match (CRLF, LF and lone CR each end a line). */
  line: number;
}

/** Pure. Lower-case `[[x]]` is not a placeholder. Order of appearance. */
export function detectPlaceholders(md: string): LegalPlaceholder[] {
  const out: LegalPlaceholder[] = [];
  const re = new RegExp(PLACEHOLDER_RE.source, 'g');
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
