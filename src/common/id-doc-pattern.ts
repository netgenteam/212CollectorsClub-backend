/**
 * Story 20.2 (AD-95, FR-129): the ONE definition of "what a Venezuelan
 * cedula / RIF / passport looks like". `normalizeIdDoc` (crypto), `redactDeep`
 * (logs) and the PII guard of `AuditService` (Story 20.1) all derive from it.
 *
 * Shape: a type letter (V E J P G), an optional separator, then 5 to 11 digits
 * either contiguous (`12345678`) or grouped by thousands (`12.345.678`,
 * `12 345 678`), and an optional `-<check digit>` (RIF). Only digits are
 * matched here (never letters after the type), so words such as `PENDING1` or
 * `EUR` are not mistaken for an ID.
 */
export const ID_DOC_TYPES = ['V', 'E', 'J', 'P', 'G'] as const;
export type IdDocType = (typeof ID_DOC_TYPES)[number];

const CORE =
  '[VEJGP][\\s.-]?(?:\\d{5,11}|\\d{1,2}(?:[.\\s]\\d{3}){2,3})(?:-\\d)?';

/**
 * In free text only (the whole-value check and the normalizer have their own passport rule):
 * `P-AB123456`, `P AB123456`. A separator is REQUIRED when letters follow, so words such as
 * `PENDING1` or `PAYMENT2` are not mistaken for a passport.
 */
const PASSPORT_WITH_LETTERS = 'P[\\s.-](?=[A-Z0-9]*\\d)[A-Z0-9]{5,12}';

/** Whole value (after trim) has the shape of an ID document. Stateless. */
const WHOLE = new RegExp(`^(?:${CORE}|${PASSPORT_WITH_LETTERS})$`, 'i');

/**
 * Occurrence inside free text. Lookarounds make it a standalone token, so the
 * first segment of a UUID (`e1234567-...`), its last segment (preceded by a 4-hex
 * group), hex hashes, tokens, dates (`2026-11-03`) and amounts (`1.234.567,89`)
 * never match. A word prefix is allowed (`ORD-V12345678` is redacted).
 */
const SOURCE_IN_TEXT = `(?<!\\w)(?<![0-9a-f]{4}-)(?:${CORE}|${PASSPORT_WITH_LETTERS})(?!\\w|-\\w)`;

export function looksLikeIdDoc(value: string): boolean {
  return value.length <= 40 && WHOLE.test(value.trim());
}

/** A fresh global regex (a shared /g regex would carry `lastIndex` between calls). */
export function newIdDocInTextRegex(): RegExp {
  return new RegExp(SOURCE_IN_TEXT, 'gi');
}
