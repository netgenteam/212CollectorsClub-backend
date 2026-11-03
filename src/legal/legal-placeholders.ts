/** Longest token body accepted (after `[[`), generous so descriptive names are never skipped. */
export const MAX_PLACEHOLDER_LENGTH = 80;

/**
 * AD-90: tokens like `[[RAZON_SOCIAL]]` or `[[RAZÓN_SOCIAL]]` (any Unicode
 * upper-case letter, so accents and ñ count; combining marks allowed for the
 * decomposed form). Conservative: also matches inside code. Story 19.3 fix:
 * the limit used to be 41 characters, which let long descriptive tokens
 * (`[[CONFIRMAR_CIFRADO_Y_RETENCION_IMPLEMENTADOS]]`) go undetected.
 */
const PLACEHOLDER_RE = new RegExp(
  `\\[\\[\\p{Lu}[\\p{Lu}\\p{M}0-9_]{1,${MAX_PLACEHOLDER_LENGTH - 1}}\\]\\]`,
  'gu',
);

/**
 * Heading phrase of every seeded template. A body that still contains it is a
 * template that was never reviewed: it cannot be published even if every
 * `[[TOKEN]]` (including `[[ELIMINAR_AVISO_DE_PLANTILLA]]`) was removed.
 */
export const LEGAL_TEMPLATE_NOTICE =
  'Plantilla — revisar con un abogado antes de publicar';

const NORMALIZE_NOTICE = (s: string): string =>
  s
    .replace(/[*_`~]/g, '')
    .replace(/[\u2012-\u2015\u2212-]/g, '-')
    .replace(/\s+/g, ' ')
    .toLowerCase();
const NOTICE_NORMALIZED = NORMALIZE_NOTICE(LEGAL_TEMPLATE_NOTICE);

/**
 * Pure. 1-based line where the template notice appears (ignoring case, extra
 * whitespace, dash variants and Markdown emphasis), or `null`.
 */
export function findTemplateNotice(md: string): number | null {
  const lines = md.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    if (NORMALIZE_NOTICE(lines[i]).includes(NOTICE_NORMALIZED)) return i + 1;
  }
  // phrase broken across lines
  if (NORMALIZE_NOTICE(md).includes(NOTICE_NORMALIZED)) {
    const flat = md.toLowerCase().indexOf('plantilla');
    return flat === -1 ? 1 : md.slice(0, flat).split(/\r\n|\r|\n/).length;
  }
  return null;
}

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
