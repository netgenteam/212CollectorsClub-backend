import { ID_DOC_TYPES, type IdDocType } from '../common/id-doc-pattern.js';

export { ID_DOC_TYPES, type IdDocType };

export interface ParsedIdDoc {
  type: IdDocType;
  /** Digits as written, leading zeros kept (V-0123456 is not V-123456). For `P` it may be alphanumeric. Includes the RIF check digit when given. */
  digits: string;
  /** `T-NNNNNNNN` (A87). */
  canonical: string;
  unparsed: false;
}
export interface UnparsedIdDoc {
  type: null;
  digits: null;
  /** Legacy value kept as found: trimmed, upper case, inner whitespace collapsed. The type is never guessed. */
  canonical: string;
  unparsed: true;
}
export type NormalizedIdDoc = ParsedIdDoc | UnparsedIdDoc;

const INVISIBLE = new RegExp('[\u200B-\u200D\u2060\uFEFF]', 'g');
const SEPARATORS = /[\s.-]/g;
const NUMERIC = /^([VEJG])(\d{5,11})$/;
/** Passports (FR-127) may carry letters: `P` + 5..12 alphanumerics with at least one digit. */
const PASSPORT = /^P(?=[A-Z0-9]*\d)([A-Z0-9]{5,12})$/;
const MAX_LEN = 256;

/**
 * Story 20.2 (A87, AD-95). Same ID, same canonical form: `V12345678`,
 * `v-12.345.678` and ` V 12 345 678 ` all give `V-12345678`. Two different IDs
 * never collapse: only case, spaces, dots, dashes and invisible characters are
 * ignored; digits (including leading zeros) and the type letter always count.
 *
 * Returns `null` for null, non-strings and blank input. A value that cannot be
 * parsed (legacy data such as `12345678` with no type, or `V-123`) is returned
 * as `unparsed` with its cleaned text, never with a guessed type.
 * Pure and synchronous: safe to call over a whole table in chunks (Story 20.3).
 */
export function normalizeIdDoc(raw: unknown): NormalizedIdDoc | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .trim()
    .toUpperCase();
  if (cleaned.length === 0) return null;
  const legacy = (): UnparsedIdDoc => ({
    type: null,
    digits: null,
    canonical: cleaned.slice(0, MAX_LEN).replace(/\s+/g, ' '),
    unparsed: true,
  });
  if (cleaned.length > MAX_LEN) return legacy();
  const compact = cleaned.replace(SEPARATORS, '');
  const m = NUMERIC.exec(compact) ?? PASSPORT.exec(compact);
  if (!m) return legacy();
  const type = (m[0].startsWith('P') ? 'P' : m[1]) as IdDocType;
  const digits = m[0].startsWith('P') ? m[1] : m[2];
  return { type, digits, canonical: `${type}-${digits}`, unparsed: false };
}
