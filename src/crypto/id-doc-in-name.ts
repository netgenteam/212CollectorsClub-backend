import { newIdDocInTextRegex } from '../common/id-doc-pattern.js';
import { normalizeIdDoc } from './id-doc-normalize.js';

/**
 * Story 20.3 (FR-123, FR-125, NFR-20.5): the legacy storefront sent the cedula INSIDE the
 * recipient name (`"Ana (V-70123456)"`). This is the one place that knows how to take it out:
 * checkout (extract + encrypt), the views (clean on read) and the backfill (extract + verify +
 * clean) all use it, so they can never disagree.
 *
 * Only an UNAMBIGUOUS token is extracted: a standalone type letter (V E J G P) followed by what
 * `normalizeIdDoc` parses (5..11 digits, optionally grouped or with a RIF check digit). "Ana 3era",
 * "Calle 12345" or "Ave 5to" have no type letter + digits token and are returned untouched.
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
    if (n && !n.unparsed) {
      hits.push({
        start: m.index,
        end: m.index + m[0].length,
        canonical: n.canonical,
      });
    }
  }
  if (hits.length === 0) return untouched;

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
