import { newIdDocInTextRegex } from '../common/id-doc-pattern.js';
import { normalizeIdDoc, type ParsedIdDoc } from './id-doc-normalize.js';

/**
 * Story 20.3 (FR-123, FR-125, NFR-20.5): the legacy storefront sent the cedula INSIDE the
 * recipient name (`"Ana (V-70123456)"`). This is the one place that knows how to take it out:
 * checkout (extract + encrypt), the views (clean on read) and the backfill (extract + verify +
 * clean) all use it, so they can never disagree.
 *
 * Only an UNAMBIGUOUS token is extracted, and "unambiguous" follows the buyer ID rules of
 * `checkout/buyer-id.ts` (Story 20.4): a standalone type letter (V E J G P) followed by a number
 * of the length that type really has: V/E 6-9 digits, J/G 9 digits (RIF, check digit included),
 * P 6-12 letters/digits. Fewer digits is a street, a lot or a company name, not a cedula:
 * `Inversiones G-20000 C.A.` and `Edificio P-12345` are left alone (before 20.4 they were turned
 * into `Inversiones C.A.` plus a fake encrypted cedula `G-20000`). The one case with no letter:
 * an unmistakable LABEL (`CI`, `C.I.`, `cédula`, `ced.`) followed by 6-9 digits is a V
 * (`Ana CI 12345678`). `RIF` and `pasaporte` labels need their type letter (a bare number after
 * them cannot be typed). "Ana 3era", "Calle 12345" or "Ave 5to" are returned untouched.
 *
 * The RIF check digit is deliberately NOT verified here: a mistyped RIF is still a RIF and must
 * not stay in clear in the name.
 */
export interface NameSplit {
  /** The recipient name without any cedula (the original string, untouched, when none was found). */
  name: string;
  /** Canonical `T-NNN…` of the FIRST cedula found, or null. */
  idDoc: string | null;
  /** More than one DIFFERENT cedula in the same name: nothing can be trusted to be "the" cedula. */
  ambiguous: boolean;
  /** True when at least one cedula was found (and removed from `name`). */
  found: boolean;
}

const INVISIBLE = new RegExp('[​-‍⁠﻿]', 'g');
/** Cheap gate: a cedula needs 5 digits in a row, or a grouped `d.ddd.ddd` / `d ddd ddd`. */
const MAYBE = /\d{5}|\d[.\s]\d{3}[.\s]\d{3}|\d{1,2}[.\s]\d{3}[.\s]\d{3}/;
const SEP = String.raw`[\s,;:/|–—-]`;
const LABEL = String.raw`(?:c\.?\s?i\.?|c[eé]dula|ced\.?|rif|pasaporte)`;
/** What precedes the token and goes with it: separators, `(`/`[`/`{`, an optional `CI:`-style label. */
const LEFT = new RegExp(
  String.raw`${SEP}*([(\[{])?\s*(?:${LABEL}\s*[:.#=-]?\s*)?([(\[{])?\s*$`,
  'i',
);
const RIGHT = /^\s*([)\]}])?/;
/**
 * A bare number (no type letter) right after a cedula LABEL: `CI 12345678`, `C.I.: 12.345.678`,
 * `cédula 12345678`. The label must start a word (`Maci 12345678` is not a label). 6-9 digits,
 * contiguous or grouped by thousands.
 */
const LABELED_BARE = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(?:c\.?\s?i\.?|c[eé]dula|ced\.?)\s*[:.#=-]?\s*((?:\d{6,9}|\d{1,3}(?:[.\s]\d{3}){2}))(?![\p{L}\p{N}]|[.\s-]?\d)`,
  'giu',
);

/** Whether a normalized token has the digit count its type really has (buyer-id.ts rules, no check digit). */
function plausibleCedula(n: ParsedIdDoc): boolean {
  switch (n.type) {
    case 'V':
    case 'E':
      return /^\d{6,9}$/.test(n.digits);
    case 'J':
    case 'G':
      return /^\d{9}$/.test(n.digits);
    case 'P':
      return /^[A-Z0-9]{6,12}$/.test(n.digits);
  }
}
const EDGE_JUNK = new RegExp(String.raw`^${SEP}+|${SEP}+$`, 'g');

export function splitIdDocFromName(raw: string): NameSplit {
  const untouched: NameSplit = {
    name: raw,
    idDoc: null,
    ambiguous: false,
    found: false,
  };
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2_000) {
    return untouched;
  }
  // Fullwidth letters/digits (`Ｖ-７０…`) and zero-width characters are folded first.
  const text = raw.normalize('NFKC').replace(INVISIBLE, '');
  if (!MAYBE.test(text)) return untouched;
  const hits: { start: number; end: number; canonical: string }[] = [];
  for (const m of text.matchAll(newIdDocInTextRegex())) {
    const n = normalizeIdDoc(m[0]);
    if (n && !n.unparsed && plausibleCedula(n)) {
      hits.push({
        start: m.index,
        end: m.index + m[0].length,
        canonical: n.canonical,
      });
    }
  }
  // `CI 12345678` (label, no letter): the digits are the hit, the label is removed with it below.
  for (const m of text.matchAll(LABELED_BARE)) {
    const digits = m[1];
    const start = m.index + m[0].length - digits.length;
    const n = normalizeIdDoc(`V${digits}`);
    if (n && !n.unparsed && plausibleCedula(n)) {
      hits.push({ start, end: start + digits.length, canonical: n.canonical });
    }
  }
  if (hits.length === 0) return untouched;
  hits.sort((a, b) => a.start - b.start);

  let out = text;
  // Right to left, so the indexes of the hits still to process stay valid.
  for (const h of [...hits].reverse()) {
    const before = out.slice(0, h.start);
    const after = out.slice(h.end);
    const l = LEFT.exec(before);
    const opened = l !== null && (l[1] !== undefined || l[2] !== undefined);
    const r = RIGHT.exec(after);
    const closeLen = opened && r?.[1] !== undefined ? r[0].length : 0;
    out =
      before.slice(0, l ? l.index : before.length) +
      ' ' +
      after.slice(closeLen);
  }
  const name = out
    .replace(/[([{]\s*[)\]}]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(EDGE_JUNK, '')
    .trim();
  const distinct = new Set(hits.map((h) => h.canonical));
  return {
    name,
    idDoc: hits[0].canonical,
    ambiguous: distinct.size > 1,
    found: true,
  };
}

/** The name as a view must show it: never a cedula, whether or not the row was migrated yet. */
export function stripIdDocFromName(raw: string): string {
  return splitIdDocFromName(raw).name;
}
