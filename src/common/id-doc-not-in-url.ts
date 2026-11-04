import { HttpStatus } from '@nestjs/common';
import { ApiException } from './api-exception.js';

/**
 * Story 20.4 (FR-124, NFR-20.5): a cedula never travels in a URL (proxy `error_log`, browser
 * history, referrers). Routes that search by cedula take it in a POST body; a request that still
 * carries one in its query string is answered 400, WITHOUT looking at (or echoing) the value and
 * WITHOUT querying anything.
 *
 * Story 20.6 closes the holes the first version had (`id-doc`, `id.doc`, `rif`, `documento`, `ci`,
 * `q=V12345678`). Two checks, both on the parsed query (the query parser has already decoded keys
 * and values, and built `a[]=` arrays and `a[b]=` objects, which are walked recursively):
 *
 *  1. KEY: split into words (camelCase, `_`, `-`, `.`, spaces, brackets; accents ignored). Sensitive
 *     when the compact form contains `iddoc` (also `id-doc`, `id_document`, `buyerIdDoc`),
 *     `cedula`, `documento`, `identificacion`, `pasaporte`, `nationalid`, or a WHOLE word is one of
 *     `ci`, `rif`, `dni`, `cedula`, `passport`. Whole words, never substrings: `orderId`,
 *     `customerId`, `cursor`, `circuit`, `rifle`, `docs` pass.
 *  2. VALUE: any string value that HAS THE SHAPE of an ID document: a type letter V/E/J/G/P plus 6-9
 *     digits (`V12345678`, `v-12.345.678`, `V 12 345 678`, a RIF with its check digit), a bare dotted
 *     `12.345.678`, or a number right after `cedula`/`C.I.`/`RIF`/`DNI`/`pasaporte`. Email-looking tokens
 *     (`v12345678@gmail.com`) are removed first (a legitimate email search), the lookarounds keep the
 *     first segment of a UUID, hashes, dates and amounts from matching, and a bare run of digits
 *     (a phone fragment, an order number) is NOT flagged: only a letter or a keyword makes it a
 *     cedula. `cursor` (opaque base64url) is not scanned.
 */
export const ID_DOC_IN_URL = 'ID_DOC_IN_URL_NOT_ALLOWED';

/** Kept for callers of the first version: keys that name a cedula (compact form is matched too). */
export const ID_DOC_QUERY_KEY = /id_?doc|cedula/i;

const SUBSTRING_KEYS = [
  'iddoc',
  'cedula',
  'documento',
  'identificacion',
  'pasaporte',
  'nationalid',
];
const WORD_KEYS = new Set(['ci', 'rif', 'dni', 'cedula', 'passport']);
/** Query keys whose value is opaque (not scanned for the shape of a cedula). */
const OPAQUE_VALUE_KEYS = new Set(['cursor']);

const strip = (s: string): string => s.normalize('NFKD').replace(/[̀-ͯ]/g, '');

function keyWords(key: string): string[] {
  return strip(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/(?<=[A-Z])(?=[A-Z][a-z])/g, ' ')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

export function isIdDocKey(key: string): boolean {
  const compact = strip(key)
    .replace(/[^A-Za-z0-9]/g, '')
    .toLowerCase();
  if (SUBSTRING_KEYS.some((k) => compact.includes(k))) return true;
  return keyWords(key).some((w) => WORD_KEYS.has(w));
}

const CEDULA_SHAPES = [
  // V12345678, v-12.345.678, V 12 345 678, J-123456789-5
  /(?<![\w.+-])[VEJGP][\s.-]{0,2}(?:\d{6,9}|\d{1,2}(?:[.\s]\d{3}){2})(?:-\d)?(?![\w@-])/i,
  // a bare dotted 12.345.678
  /(?<![\w.,-])\d{1,2}\.\d{3}\.\d{3}(?![\w,]|\.\d)/,
  // "cedula 12345678", "C.I. V-12345678", "rif: 123456789"
  /(?<![\w])(?:c[eé]dula|c\.i\.?|ci|rif|dni|pasaporte)(?![\w])\W{0,6}[VEJGP]?[\s.-]?\d{6,9}(?!\d)/i,
];

/**
 * Removes every whitespace-delimited token that holds an `@` with something on each side (what
 * `/\S+@\S+/g` removed, but that regex is QUADRATIC on a long run without whitespace: about 90 ms
 * for 15 000 characters in a query value). Linear: one pass over the tokens.
 */
export function withoutEmailTokens(text: string): string {
  if (text.indexOf('@') < 0) return text;
  return text.replace(/\S+/g, (tok) => {
    // the first '@' that is not the first character must not be the last one either
    const i = tok.indexOf('@', 1);
    return i >= 1 && i <= tok.length - 2 ? ' ' : tok;
  });
}

/** True when free text holds something shaped like a cedula (an email token is ignored). */
export function looksLikeIdDocInText(value: string): boolean {
  const text = withoutEmailTokens(value.normalize('NFKC'));
  return CEDULA_SHAPES.some((re) => re.test(text));
}

const MAX_DEPTH = 6;
const MAX_NODES = 500;

function offends(
  value: unknown,
  depth: number,
  budget: { n: number },
): boolean {
  if (++budget.n > MAX_NODES) return true; // absurdly large query: refuse it
  if (typeof value === 'string') return looksLikeIdDocInText(value);
  if (depth >= MAX_DEPTH) return value !== null && typeof value === 'object';
  if (Array.isArray(value)) {
    return value.some((v) => offends(v, depth + 1, budget));
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isIdDocKey(k)) return true;
      if (OPAQUE_VALUE_KEYS.has(k.toLowerCase())) continue;
      if (offends(v, depth + 1, budget)) return true;
    }
  }
  return false;
}

export function assertNoIdDocInQuery(
  query: Record<string, unknown> | undefined,
  postPath: string,
): void {
  if (!query) return;
  if (offends(query, 0, { n: 0 })) {
    throw new ApiException(
      HttpStatus.BAD_REQUEST,
      ID_DOC_IN_URL,
      `An ID document must not be sent in the URL. Use ${postPath} with a JSON body.`,
      { reason: 'USE_POST_SEARCH' },
    );
  }
}
