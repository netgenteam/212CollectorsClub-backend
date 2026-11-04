import { normalizeIdDoc } from './id-doc-normalize.js';

/**
 * Story 20.2 (A87, FR-125): `V-12345678` -> `V-****5678` (type + last 4
 * digits); with 4 digits or fewer nothing of the number is shown: `V-****`.
 * Never throws. Null/blank/non-string -> `null`. A legacy value with no
 * recognizable type shows no type and, only if it ends in 4 digits and is at
 * least 8 characters long, those 4 digits (`****5678`), else `****`.
 */
export function maskIdDoc(value: unknown): string | null {
  const n = normalizeIdDoc(value);
  if (n === null) return null;
  if (!n.unparsed) {
    const tail = n.digits.length > 4 ? n.digits.slice(-4) : '';
    return `${n.type}-****${tail}`;
  }
  const c = n.canonical;
  // Typed but too short to be a real ID (e.g. `V-1234`): the spec form, no digits shown.
  const short = /^([VEJGP])[\s.-]?\d{1,4}$/.exec(c);
  if (short) return `${short[1]}-****`;
  return c.length >= 8 && /\d{4}$/.test(c) ? `****${c.slice(-4)}` : '****';
}
