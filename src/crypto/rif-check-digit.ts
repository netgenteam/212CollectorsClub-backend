import type { IdDocType } from '../common/id-doc-pattern.js';

/** Weights over `[letterValue, d1..d8]` (A98). */
const WEIGHTS = [4, 3, 2, 7, 6, 5, 4, 3, 2] as const;
const LETTER_VALUE: Record<IdDocType, number> = {
  V: 1,
  E: 2,
  J: 3,
  P: 4,
  G: 5,
};

/**
 * Story 20.2 (A98, A89): SENIAT RIF check digit, computed locally (no SENIAT
 * lookup). `dv = 11 - (sum mod 11)`; 11 -> 0 and 10 -> 9.
 * `first8` are the 8 digits before the check digit (cedula padded with zeros).
 */
export function rifCheckDigit(type: IdDocType, first8: string): number {
  if (!/^\d{8}$/.test(first8)) throw new TypeError('first8 must be 8 digits');
  let sum = LETTER_VALUE[type] * WEIGHTS[0];
  for (let i = 0; i < 8; i++) sum += Number(first8[i]) * WEIGHTS[i + 1];
  const dv = 11 - (sum % 11);
  if (dv === 11) return 0;
  if (dv === 10) return 9;
  return dv;
}

/** `RIF_CHECKDIGIT_STRICT=false` degrades validation to format only (A98, R6). Default: strict. */
export function isRifCheckDigitStrict(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (env.RIF_CHECKDIGIT_STRICT ?? '').trim().toLowerCase() !== 'false';
}

/**
 * RIF = type + 9 digits (8 + check digit). Strict: the check digit must
 * match. Non-strict: only the format is verified.
 */
export function isValidRif(
  type: string,
  digits: string,
  opts: { strict?: boolean } = {},
): boolean {
  if (!Object.hasOwn(LETTER_VALUE, type) || !/^\d{9}$/.test(digits)) {
    return false;
  }
  if (!(opts.strict ?? isRifCheckDigitStrict())) return true;
  return (
    rifCheckDigit(type as IdDocType, digits.slice(0, 8)) === Number(digits[8])
  );
}
