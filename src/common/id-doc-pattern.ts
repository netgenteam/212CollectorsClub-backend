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

/** Whole value (after trim) has the shape of an ID document. Stateless. */
const WHOLE = new RegExp(`^${CORE}$`, 'i');

/**
 * Occurrence inside free text. Lookarounds make it a standalone token, so the
 * first segment of a UUID (`e1234567-...`), hex hashes, tokens, dates
 * (`2026-11-03`) and amounts (`1.234.567,89`) never match.
 */
const SOURCE_IN_TEXT = `(?<!\\w)(?<!\\w-)${CORE}(?!\\w|-\\w)`;

export function looksLikeIdDoc(value: string): boolean {
  return value.length <= 40 && WHOLE.test(value.trim());
}

/** A fresh global regex (a shared /g regex would carry `lastIndex` between calls). */
export function newIdDocInTextRegex(): RegExp {
  return new RegExp(SOURCE_IN_TEXT, 'gi');
}
