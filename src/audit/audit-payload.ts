import { pgText, truncateCodePoints } from './audit-normalize.js';
import { CUT_MARGIN, commonPrefix } from '../common/redact-cut.js';

/**
 * Story 20.1 (AD-99, FR-139, NFR-20.5): the `before`/`after` of an audit event
 * (and the `reason`) hold ONLY strings, safe integers, booleans and null (nested
 * objects/arrays of those are fine). No floats (`jsonb` normalizes numbers, so a
 * float would break the hash round trip: money goes as a string) and no PII or
 * secrets in clear: emails go as `emailHash`. The log is immutable, so a leaked
 * value can never be removed: the guard is the last line of defence.
 *
 * ## Two modes (the criterion)
 *
 * A data-dependent false positive must never cost a sale, and a programming
 * error must be seen before production:
 *   - `strict` (every NODE_ENV but `production`: dev, CI, the whole test suite):
 *     any violation throws `AuditPayloadError`, so the test of the call site
 *     fails loudly.
 *   - `lenient` (`NODE_ENV=production`): the action is NOT failed. The offending
 *     value is replaced by a marker (`[REDACTED:EMAIL]`, ...), a float/huge
 *     integer becomes its decimal string, a key holding an `undefined` is
 *     dropped, and the paths + reasons (never the values) are logged as a
 *     warning. The log stays free of PII and the sale goes through.
 *   Override with `AUDIT_PAYLOAD_STRICT=true|false`. Violations that are bugs of
 *   the code, not of the data (a `Date`/`BigInt`/class instance, nesting > 8,
 *   two keys that collapse into one) throw in both modes.
 *
 * ## Public business data (per action, explicit)
 *
 * The guard exists for the CUSTOMERS' personal data. The seller's own RIF, fiscal
 * address, contact email/phone and Pago Movil account are published by the seller,
 * and `SELLER_IDENTITY_UPDATED` has to carry them. Each action may list, in the
 * catalog (`AUDIT_ACTIONS[action].publicFields`), the exact keys it may carry and
 * the value classes each is exempt from (see `PublicFields`). Everything else keeps
 * being checked on that action, and no `CUSTOMER_*` / `ORDER_*` action has a list.
 *
 * ## Dates, BigInt, Decimal
 *
 * They throw in both modes (a code bug, seen by the call site's test). Build the
 * payload from a database row with `toAuditPayload(row)`, or convert one value with
 * `auditDate` / `auditBigInt` / `auditDecimal`. A path in an error or a warning never
 * shows a key that is itself sensitive (`[REDACTED:EMAIL]`), and is capped.
 *
 * ## What is detected (precision first: a sale must not break)
 *
 * KEY NAMES are split in words (`camelCase`, `snake_case`, `kebab-case`,
 * accents ignored) and matched as WHOLE words, never as substrings:
 * `secretary` is not `secret`. A key is sensitive when it contains
 *   - a secret word (`password(s)`, `passwd`, `pwd`, `secret`, `token(s)`, `jwt`,
 *     `bearer`, `cookie`, `authorization`, `ciphertext`, `cvv`, `otp`, or the
 *     pairs `api key`, `private key`, `access key`, `card number`, `credit card`),
 *     never allowed, not even as a hash; or
 *   - a personal-data word (`email`, `mail`, `correo`, `phone`, `telefono`,
 *     `cedula`, `dni`, `rif`, `documento`, `passport`, `address`, `direccion`,
 *     the pairs `id doc`, `national id`), allowed only as a hash (`...Hash`).
 * ... UNLESS the LAST word says the key describes the field instead of holding
 * it: `id(s)`, `count`, `verified`, `changed`, `issued`, `at`, `by`, `status`,
 * `type`, `length`, `sent`, ... (`addressId`, `emailVerified`, `tokensIssued`,
 * `passwordChanged`). `ip address` / `mac address` are not personal data here.
 * A key that itself looks like PII (`"maria@x.com": 1`) is detected as a value.
 *
 * VALUES (and the `reason`; `[REDACTED:X]` markers do not match any detector):
 *   EMAIL, JWT, SECRET (`sk_live_`/`sk_test_`/`whsec_`, `Bearer <token>`, AWS/
 *   GitHub/Slack keys, PEM private keys, `password=...`), PHONE (`+<country>`
 *   numbers, Venezuelan `04xx`/`02xx`/`58...`, `(555) 123-4567`), CARD (13-19
 *   digits with a real issuer prefix AND a valid Luhn sum), CEDULA.
 * CEDULA is deliberately stricter than the log redactor of Story 20.2
 * (`id-doc-pattern.ts`): over-redacting a log line costs nothing, a false positive
 * here would sit in the way of a checkout and product ids look like IDs. It
 * flags: `V`/`E` + 7-9 digits (or dotted `12.345.678`), `J`/`G` + 8 digits and an
 * optional check digit (RIF), `P` + 8-11 digits, a bare dotted `12.345.678`,
 * and a number written right after `cedula`, `C.I.`, `RIF`, `DNI`, `pasaporte`.
 * It does NOT flag `P-12345`, `V-100000`, `E-123456`, `G-12345` (too short to be a
 * document), nor a bare run of digits without letter or keyword.
 */
export type AuditScalar = string | number | boolean | null;

/** Value detectors a public field may legitimately trip (see `PublicFields`). */
export type PublicValueClass = 'EMAIL' | 'PHONE' | 'CEDULA';

/**
 * Per-action allowance of PUBLIC business data (Story 20.1 fix, for 20.5): key
 * PATH -> value detectors that key is exempt from. A path is the key name for a
 * first-level key of the payload (`address`) and a dotted path with `[]` for array
 * elements for anything deeper (`branches[].address`); a key that is not at its declared
 * path is not exempt (`{ customer: { rif } }` is not `rif`). Dots, brackets and backslashes
 * inside a key name are escaped with a backslash. The sellers' RIF, fiscal
 * address, contact email/phone and Pago Movil account are published by the
 * seller itself; what the guard protects is the CUSTOMERS' personal data. The
 * allowance lives in the catalog (`AUDIT_ACTIONS[action].publicFields`) so it is
 * explicit, reviewed per action and invisible to every other action: a
 * `CUSTOMER_*` / `ORDER_*` event still rejects `rif`, `address`, `phone`...
 * An exempt key is matched EXACTLY (case-sensitive), its value must be a string
 * or null (never an object/array that could smuggle nested keys), and it is
 * exempt only from the listed classes: a card number, a JWT, a secret or any
 * other detector still trips on its value. Secret key names (`password`,
 * `token`...) are never exempt. `cedula`, `idDoc` and the like are not public
 * data of anybody and are not in any list.
 */
export type PublicFields = Readonly<
  Record<string, readonly PublicValueClass[]>
>;
export type AuditPayload =
  AuditScalar | AuditPayload[] | { [key: string]: AuditPayload };

export class AuditPayloadError extends Error {
  constructor(path: string, why: string) {
    super(`Invalid audit payload at ${path}: ${why}`);
    this.name = 'AuditPayloadError';
  }
}

export type AuditPayloadMode = 'strict' | 'lenient';

/** `AUDIT_PAYLOAD_STRICT` wins; otherwise lenient only in production. */
export function auditPayloadMode(): AuditPayloadMode {
  const o = (process.env.AUDIT_PAYLOAD_STRICT ?? '').trim().toLowerCase();
  if (o === 'true') return 'strict';
  if (o === 'false') return 'lenient';
  return process.env.NODE_ENV === 'production' ? 'lenient' : 'strict';
}

export interface PayloadIssue {
  path: string;
  why: string;
}

// ─── key names ────────────────────────────────────────────────────────────

const SECRET_WORDS = new Set([
  'password',
  'passwords',
  'passwd',
  'pwd',
  'passphrase',
  'secret',
  'secrets',
  'token',
  'tokens',
  'jwt',
  'bearer',
  'cookie',
  'cookies',
  'authorization',
  'ciphertext',
  'cvv',
  'cvc',
  'otp',
  'apikey',
  'privatekey',
]);
const SECRET_PAIRS = new Set([
  'api key',
  'private key',
  'access key',
  'card number',
  'card num',
  'credit card',
]);
const PII_WORDS = new Set([
  'email',
  'emails',
  'mail',
  'mails',
  'correo',
  'correos',
  'phone',
  'phones',
  'telefono',
  'telefonos',
  'tel',
  'movil',
  'celular',
  'cedula',
  'cedulas',
  'dni',
  'rif',
  'documento',
  'documentos',
  'passport',
  'pasaporte',
  'address',
  'addresses',
  'direccion',
  'direcciones',
  'iddoc',
  'buyeriddoc',
  'recipientiddoc',
  'ssn',
]);
const PII_PAIRS = new Set(['id doc', 'id document', 'national id']);
/** Last words that make a key describe the field rather than hold the value. */
const DESCRIBES = new Set([
  'id',
  'ids',
  'uuid',
  'count',
  'total',
  'verified',
  'changed',
  'issued',
  'at',
  'by',
  'status',
  'type',
  'kind',
  'length',
  'len',
  'size',
  'present',
  'exists',
  'set',
  'enabled',
  'disabled',
  'required',
  'valid',
  'invalid',
  'expired',
  'expires',
  'expiry',
  'revoked',
  'rotated',
  'sent',
  'confirmed',
  'updated',
  'created',
  'deleted',
  'ttl',
  'version',
  'source',
  'flag',
  'provided',
  'missing',
]);
/** `ipAddress` / `macAddress` hold a network address, not a postal one. */
const NOT_POSTAL = new Set(['ip', 'mac', 'web', 'url']);

function words(key: string): string[] {
  return key
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/(?<=[A-Z])(?=[A-Z][a-z])/g, ' ')
    .replace(/([A-Za-z])([0-9])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/** Why a key name is not allowed, or null. Exported for the unit tests. */
export function keyViolation(key: string): string | null {
  const w = words(key);
  if (w.length === 0) return null;
  const last = w[w.length - 1];
  const describes = DESCRIBES.has(last);
  const isHash = last === 'hash';
  for (let i = 0; i < w.length; i += 1) {
    const pair = i + 1 < w.length ? `${w[i]} ${w[i + 1]}` : '';
    const secret =
      SECRET_WORDS.has(w[i]) || (pair !== '' && SECRET_PAIRS.has(pair));
    if (secret && !describes) return 'key names a secret';
    const pii =
      (PII_WORDS.has(w[i]) &&
        !(w[i] === 'address' && NOT_POSTAL.has(w[i - 1]))) ||
      (pair !== '' && PII_PAIRS.has(pair));
    if (pii && !describes && !isHash) return 'key names personal data';
  }
  return null;
}

// ─── values ───────────────────────────────────────────────────────────────

interface Detector {
  name: string;
  /** A regex (replaced with `String.replace`) ... */
  re?: RegExp;
  accept?: (match: string) => boolean;
  /**
   * ... or a hand-written LINEAR scanner: the `[start, end)` spans of the matches, in order and not
   * overlapping (for what a regex cannot do in linear time).
   */
  spans?: (s: string) => Array<[number, number]>;
}

/**
 * Spans of email-looking tokens: `[^\s@]+@[^\s@]+\.[^\s@]+`. As a regex it is QUADRATIC on any long
 * run without whitespace (every start scans to the end of the run looking for an `@`: measured,
 * 8 000 characters 30 ms, 32 000 characters 0.5 s, for EVERY input shape, and 15 000 characters
 * about 90 ms in the query-string check). Here the text is split in whitespace-free tokens and each
 * token on its `@`s: the local part is the non-empty piece before an `@`, the domain the piece after
 * it, which needs a `.` with a character on each side. Every character is looked at a constant
 * number of times. Same matches as the regex (differential test in `audit-payload.spec.ts`).
 */
export function emailSpans(s: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  if (s.indexOf('@') < 0) return spans;
  const isSpace = (c: number): boolean =>
    c === 32 ||
    (c >= 9 && c <= 13) ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff;
  const n = s.length;
  let i = 0;
  while (i < n) {
    while (i < n && isSpace(s.charCodeAt(i))) i += 1;
    const tokStart = i;
    while (i < n && !isSpace(s.charCodeAt(i))) i += 1;
    const tokEnd = i;
    if (tokEnd - tokStart < 3) continue;
    // pieces between '@'s: [tokStart, a1), (a1, a2), ...
    let consumedUntil = tokStart; // text before this index belongs to an earlier match
    let pieceStart = tokStart;
    let at = s.indexOf('@', pieceStart);
    while (at >= 0 && at < tokEnd) {
      const localStart = Math.max(pieceStart, consumedUntil);
      const next = s.indexOf('@', at + 1);
      const domainEnd = next >= 0 && next < tokEnd ? next : tokEnd;
      if (at > localStart && domainEnd - (at + 1) >= 3) {
        // a '.' inside the domain with something on both sides
        const dot = s.indexOf('.', at + 2);
        if (dot >= 0 && dot < domainEnd - 1) {
          spans.push([localStart, domainEnd]);
          consumedUntil = domainEnd;
        }
      }
      pieceStart = at + 1;
      at = next;
    }
  }
  return spans;
}

const luhn = (digits: string): boolean => {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
};

const ISSUER_PREFIX =
  /^(?:4|5[1-5]|2(?:2[2-9]|[3-6]\d|7[01]|720)|3[47]|30[0-5]|36|38|35|6011|65|64[4-9]|62)/;

const cardAccept = (m: string): boolean => {
  const d = m.replace(/\D/g, '');
  return d.length >= 13 && d.length <= 19 && ISSUER_PREFIX.test(d) && luhn(d);
};

// Standalone token: not glued to a word or to `x-` / `-x` (UUID segments, SKUs, dates).
const L = String.raw`(?<!\w)(?<!\w-)`;
const R = String.raw`(?!\w|-\w)`;
const CEDULA_VE = String.raw`[VE][\s.-]?(?:\d{7,9}|\d{1,2}(?:[.\s]\d{3}){2})(?:-\d)?`;
const CEDULA_RIF = String.raw`[JG][\s.-]?\d{8}(?:-?\d)?`;
const CEDULA_P = String.raw`P[\s.-]?\d{8,11}`;

/** Order matters only for readability: markers contain nothing a later detector matches. */
const DETECTORS: Detector[] = [
  { name: 'EMAIL', spans: emailSpans },
  { name: 'JWT', re: /(?<![\w-])eyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]*/g },
  {
    name: 'SECRET',
    re: new RegExp(
      [
        String.raw`\b(?:sk|rk)_(?:live|test)_\w*`,
        String.raw`\bwhsec_\w+`,
        String.raw`\bBearer\s+(?=[\w.~+/=-]*[\d.])[\w.~+/=-]{8,}`,
        String.raw`\bAKIA[0-9A-Z]{16}\b`,
        String.raw`\bgh[pousr]_[A-Za-z0-9]{20,}`,
        String.raw`\bxox[baprs]-[\w-]{10,}`,
        String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----`,
        String.raw`\b(?:password|passwd|pwd|passphrase|secret)\s*[:=]\s*\S{3,}`,
        String.raw`\b(?:api[_-]?key|access[_-]?token|token)\s*[:=]\s*(?=\S{0,256}\d)\S{8,}`,
      ].join('|'),
      'gi',
    ),
  },
  {
    name: 'PHONE',
    re: new RegExp(
      [
        String.raw`(?<![\w+])\+\d{1,3}[\s.()-]*\d(?:[\s.()-]*\d){6,11}(?!\w)`,
        String.raw`(?<![\w.+-])(?:58[\s.-]?0?|0)(?:4(?:12|14|16|24|26)|2\d\d)[\s.-]?\d{3}[\s.-]?\d{4}(?!\w|-\w)`,
        String.raw`(?<![\w.+-])\(\d{3}\)\s?\d{3}[\s.-]\d{4}(?!\w)`,
        String.raw`(?<![\w.+-])\d{3}[\s.-]\d{3}[\s.-]\d{4}(?![\w-])`,
      ].join('|'),
      'g',
    ),
  },
  {
    name: 'CARD',
    re: /(?<![\w.-])(?:\d[ -]?){12,18}\d(?![\w-])/g,
    accept: cardAccept,
  },
  {
    name: 'CEDULA',
    re: new RegExp(
      [
        `${L}(?:${CEDULA_VE}|${CEDULA_RIF}|${CEDULA_P})${R}`,
        String.raw`(?<![\w.,-])\d{1,2}\.\d{3}\.\d{3}(?![\w,]|\.\d)`,
        String.raw`\b(?:c[eé]dula|c\.i\.?|rif|dni|pasaporte|identificaci[oó]n)\b\W{0,6}(?:n[o°º]?\W{0,3})?[VEJGP]?\d[\d.\s-]{4,14}\d`,
      ].join('|'),
      'gi',
    ),
  },
];

const LABEL: Record<string, string> = {
  EMAIL: 'an email address (PII)',
  JWT: 'a JWT (secret)',
  SECRET: 'a credential (secret)',
  PHONE: 'a phone number (PII)',
  CARD: 'a card number (PII)',
  CEDULA: 'an ID document (PII)',
};
const labels = (hits: string[]): string =>
  [...new Set(hits)].map((h) => LABEL[h] ?? h).join(' / ');

/** Replaces every detected sensitive token; returns the names found (empty: nothing changed). */
export function redactText(
  s: string,
  exempt: readonly string[] = [],
): { text: string; hits: string[] } {
  const hits: string[] = [];
  let text = s;
  for (const d of DETECTORS) {
    if (exempt.includes(d.name)) continue;
    if (d.spans !== undefined) {
      const spans = d.spans(text);
      if (spans.length === 0) continue;
      let out = '';
      let pos = 0;
      for (const [from, to] of spans) {
        out += `${text.slice(pos, from)}[REDACTED:${d.name}]`;
        pos = to;
        hits.push(d.name);
      }
      text = out + text.slice(pos);
      continue;
    }
    text = text.replace(d.re as RegExp, (m) => {
      if (d.accept && !d.accept(m)) return m;
      hits.push(d.name);
      return `[REDACTED:${d.name}]`;
    });
  }
  return { text, hits };
}

/** Free text (a `reason`): sensitive tokens are masked in BOTH modes, the action never fails. */
export function redactReason(s: string): { text: string; hits: string[] } {
  return redactText(pgText(s));
}

/**
 * The `reason` as the audit log stores it: at most `maxCodePoints` code points, sensitive tokens
 * masked, and the cut made AFTER masking (`V-123456` of a cedula cut at the limit, or `maria@gmail`
 * of an email, stays out of the immutable row: the window is `CUT_MARGIN` longer than the cut).
 * `hits` are those of the wide window (a token that straddles the cut counts).
 */
export function redactReasonCut(
  s: string,
  maxCodePoints: number,
): { text: string; hits: string[] } {
  const cut = truncateCodePoints(s, maxCodePoints);
  if (cut.length === s.length) return redactReason(s);
  const wide = redactReason(truncateCodePoints(s, maxCodePoints + CUT_MARGIN));
  const narrow = redactReason(cut);
  return { text: commonPrefix(wide.text, narrow.text), hits: wide.hits };
}

// ─── the walk ─────────────────────────────────────────────────────────────

const MAX_DEPTH = 8;
/** Longest string a payload may carry (see the note in `sanitizeAuditPayload`). */
const MAX_STRING_CHARS = 8_000;
/**
 * Longest KEY a payload may carry. No real payload has a key longer than a field name. (A 150 000-digit
 * key took 11.3 s with the old quadratic detectors; see `emailSpans`.)
 */
const MAX_KEY_CHARS = 256;
/**
 * Budget of detector WORK for ONE payload, kept as a second line of defence. The detectors were
 * quadratic in the longest unbroken (no whitespace) run of a string (the email regex: measured, dev
 * machine, 8 000 characters 27-32 ms, 50 000 about 1.1 s, 150 000 about 11 s); since QA round 3 they
 * are linear (`emailSpans`, a bounded lookahead in SECRET; `test/guard-redact-bounds.perf.spec.ts`
 * fuzzes 70 shapes and fixes a ceiling), so this budget is no longer what keeps a payload fast. It
 * still bounds the TOTAL work: the SUM of the squares of the unbroken runs of 64+ characters; 256e6
 * is about four 8 000-character tokens. Ordinary text (words, sentences, a 100 kB payload of
 * 1 000-character tokens, 1e8) is unaffected. Past the budget a string becomes a marker (strict:
 * violation, thrown; lenient: marker + issue) BEFORE any scan.
 */
const MAX_PAYLOAD_SCAN_COST = 256e6;
const LONG_RUN = /\S{64,}/g;

/** Quadratic cost of scanning `s`: the sum of the squares of its unbroken runs of 64+ characters. */
function scanCost(s: string): number {
  if (s.length < 64) return 0;
  let cost = 0;
  for (const m of s.matchAll(LONG_RUN)) cost += m[0].length * m[0].length;
  return cost;
}

/** A key as shown in a path: capped, so a huge key cannot flood a log line. */
const pathKey = (k: string): string =>
  k.length > 64 ? `${k.slice(0, 64)}...` : k;

/**
 * decimal.js (what Prisma returns for `Decimal` columns) tags its instances with
 * `Symbol.toStringTag = 'Decimal'`. The CLASS NAME is not reliable: Prisma's bundled copy is
 * called `Decimal2`, so a `constructor.name === 'Decimal'` test missed every real Prisma Decimal
 * (Story 20.5: an unconverted money column would have thrown in production and failed a sale).
 */
const isDecimal = (v: unknown): v is { toFixed(): string } =>
  typeof v === 'object' &&
  v !== null &&
  Object.prototype.toString.call(v) === '[object Decimal]' &&
  typeof (v as { toFixed?: unknown }).toFixed === 'function';

function unsupportedWhy(v: unknown): string {
  if (v instanceof Date) {
    return 'a Date is not allowed (use auditDate(d) or toAuditPayload(obj))';
  }
  if (typeof v === 'bigint') {
    return 'a BigInt is not allowed (use auditBigInt(n) or toAuditPayload(obj))';
  }
  if (isDecimal(v)) {
    return 'a Decimal is not allowed (use auditDecimal(d) or toAuditPayload(obj))';
  }
  const ctor =
    typeof v === 'object' && v !== null
      ? ((v as { constructor?: { name?: string } }).constructor?.name ??
        'object')
      : typeof v;
  return `unsupported value (${ctor}); only plain objects, arrays, strings, safe integers, booleans and null are allowed`;
}

// ─── helpers for the emitters (Story 20.5) ────────────────────────────────

/** `Date` -> ISO-8601 string (UTC). Invalid dates throw `AuditPayloadError`. */
export function auditDate(d: Date): string {
  if (Number.isNaN(d.getTime())) {
    throw new AuditPayloadError('$', 'invalid Date');
  }
  return d.toISOString();
}

/** `bigint` -> decimal string. */
export const auditBigInt = (n: bigint): string => n.toString();

/** Prisma `Decimal` (money, rates) -> plain decimal string, never exponent form. */
export function auditDecimal(d: { toFixed(): string }): string {
  return d.toFixed();
}

/**
 * Deep-converts what Prisma returns (`Date`, `bigint`, `Decimal`) into what the
 * guard accepts (strings); `undefined` keys are dropped. Everything else is
 * passed through untouched for `sanitizeAuditPayload` to judge. Use it on any
 * payload built from a database row: the guard throws on those types in BOTH
 * modes (a programming error must fail the test, never production), and a
 * `Decimal`/`Date` typed value does not compile as an `AuditPayload` either.
 */
export function toAuditPayload(v: unknown): AuditPayload {
  const conv = (x: unknown): unknown => {
    if (x instanceof Date) return auditDate(x);
    if (typeof x === 'bigint') return auditBigInt(x);
    if (isDecimal(x)) return auditDecimal(x);
    if (Array.isArray(x)) return x.map(conv);
    if (
      typeof x === 'object' &&
      x !== null &&
      (Object.getPrototypeOf(x) === Object.prototype ||
        Object.getPrototypeOf(x) === null)
    ) {
      const out: Record<string, unknown> = {};
      for (const [k, y] of Object.entries(x)) {
        if (y === undefined) continue;
        Object.defineProperty(out, k, {
          value: conv(y),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return out;
    }
    return x;
  };
  return conv(v) as AuditPayload;
}

export interface SanitizeResult {
  value: AuditPayload;
  issues: PayloadIssue[];
}

/**
 * Normalizes (strings and keys as Postgres will store them, `-0` as 0) and
 * checks a payload. In `strict` mode the first violation throws; in `lenient`
 * mode violations are repaired and returned in `issues` (no values).
 */
export function sanitizeAuditPayload(
  value: unknown,
  mode: AuditPayloadMode = auditPayloadMode(),
  rootPath = '$',
  publicFields?: PublicFields,
): SanitizeResult {
  const issues: PayloadIssue[] = [];
  const violation = (path: string, why: string): void => {
    if (mode === 'strict') throw new AuditPayloadError(path, why);
    issues.push({ path, why });
  };

  let scanned = 0;
  /** Pays the cost of scanning `s` from the payload's budget; false: spent. */
  const spend = (s: string): boolean => {
    scanned += scanCost(s);
    return scanned <= MAX_PAYLOAD_SCAN_COST;
  };

  const text = (
    s: string,
    path: string,
    exempt: readonly PublicValueClass[] = [],
  ): string => {
    // An audit event is a diff, not a document: a longer string is a violation (strict: thrown;
    // lenient: cut) BEFORE any scan. The cut is made AFTER redacting (QA round 3): cutting first
    // left `V-123456` (a cedula whose last digits were cut) in an IMMUTABLE row. The window is
    // `CUT_MARGIN` longer than the cut, so a token that straddles it is recognised and replaced.
    const over = s.length > MAX_STRING_CHARS;
    if (over) {
      violation(path, `string longer than ${MAX_STRING_CHARS} characters`);
      s = s.slice(0, MAX_STRING_CHARS + CUT_MARGIN);
    }
    if (!spend(s)) {
      violation(path, 'payload text over the scan budget');
      return '[TRUNCATED]';
    }
    const clean = pgText(s);
    const { text: wide, hits } = redactText(clean, exempt);
    const out = over
      ? commonPrefix(
          wide,
          redactText(pgText(s.slice(0, MAX_STRING_CHARS)), exempt).text,
        )
      : wide;
    if (hits.length > 0) {
      violation(path, `looks like ${labels(hits)}`);
      return out;
    }
    return over ? out : clean;
  };

  /** One segment of a declared public-field path (`.` `[` `]` `\\` in a key are escaped). */
  const seg = (k: string): string => k.replace(/[.[\]\\]/g, (c) => `\\${c}`);

  const walk = (
    v: unknown,
    path: string,
    depth: number,
    logical: string,
  ): AuditPayload => {
    if (depth > MAX_DEPTH) throw new AuditPayloadError(path, 'nested too deep');
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'number') {
      if (Number.isSafeInteger(v)) return Object.is(v, -0) ? 0 : v;
      violation(
        path,
        'numbers must be safe integers (send money/decimals as strings)',
      );
      return String(v);
    }
    if (typeof v === 'string') return text(v, path);
    if (Array.isArray(v)) {
      return v.map((x, i) =>
        x === undefined
          ? (violation(`${path}[${i}]`, 'undefined'), null)
          : walk(x, `${path}[${i}]`, depth + 1, `${logical}[]`),
      );
    }
    if (
      typeof v === 'object' &&
      (Object.getPrototypeOf(v) === Object.prototype ||
        Object.getPrototypeOf(v) === null)
    ) {
      const out: { [key: string]: AuditPayload } = {};
      for (const [k, x] of Object.entries(v)) {
        let rawKey = k;
        const longKey = rawKey.length > MAX_KEY_CHARS;
        if (longKey) {
          violation(
            `${path}.${pathKey(rawKey)}`,
            `key longer than ${MAX_KEY_CHARS} characters`,
          );
          // Redact BEFORE cutting (see `text`): the window is longer than the cut.
          rawKey = rawKey.slice(0, MAX_KEY_CHARS + CUT_MARGIN);
        }
        if (!spend(rawKey)) {
          violation(
            `${path}.${pathKey(rawKey)}`,
            'payload text over the scan budget',
          );
          rawKey = '[TRUNCATED]';
        }
        let key = pgText(rawKey);
        const wideKey = redactText(key);
        const keyHits = wideKey.hits;
        if (keyHits.length > 0 || longKey) {
          // The key itself is the sensitive value: it must reach neither the
          // payload, the path of the error/warning nor the log.
          key = wideKey.text;
        }
        if (longKey && rawKey !== '[TRUNCATED]') {
          key = commonPrefix(
            key,
            redactText(pgText(rawKey.slice(0, MAX_KEY_CHARS))).text,
          );
        }
        const kPath = `${path}.${pathKey(key)}`;
        // Where this key sits, for the public-field catalog: `address` at the first level,
        // `branches[].address` inside an array of objects. A nested key is public only if
        // its FULL path is declared: `{ customer: { rif } }` is not `rif`.
        const lPath = logical === '' ? seg(key) : `${logical}.${seg(key)}`;
        if (keyHits.length > 0) {
          violation(kPath, `key looks like ${labels(keyHits)}`);
        }
        if (Object.prototype.hasOwnProperty.call(out, key)) {
          // Two different keys that Postgres cannot tell apart (`a\ud800` / `a\ud801`)
          // or two PII-looking keys: strict mode is a bug to fix; lenient keeps both.
          if (keyHits.length === 0) {
            violation(kPath, 'two keys collapse into one');
          }
          let n = 2;
          while (Object.prototype.hasOwnProperty.call(out, `${key}#${n}`)) {
            n += 1;
          }
          key = `${key}#${n}`;
        }
        let item: AuditPayload;
        const pub =
          keyHits.length === 0 &&
          publicFields !== undefined &&
          Object.prototype.hasOwnProperty.call(publicFields, lPath)
            ? publicFields[lPath]
            : undefined;
        const kv = pub === undefined ? keyViolation(key) : null;
        if (x === undefined) {
          violation(kPath, 'undefined (omit the key)');
          continue;
        } else if (kv !== null) {
          violation(kPath, kv);
          item = '[REDACTED:KEY]';
        } else if (pub !== undefined) {
          // Public business data: scalar text only, exempt just from its classes.
          if (x === null) item = null;
          else if (typeof x === 'string') item = text(x, kPath, pub);
          else {
            violation(kPath, 'a public field must be a string or null');
            item = '[REDACTED:KEY]';
          }
        } else {
          item = walk(x, kPath, depth + 1, lPath);
        }
        // defineProperty: a `__proto__` key must stay an own property.
        Object.defineProperty(out, key, {
          value: item,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return out;
    }
    throw new AuditPayloadError(path, unsupportedWhy(v));
  };

  return { value: walk(value, rootPath, 0, ''), issues };
}

/** Strict check (throws `AuditPayloadError`); kept for callers and tests that only validate. */
export function assertAuditPayload(
  value: unknown,
  path = '$',
): asserts value is AuditPayload {
  sanitizeAuditPayload(value, 'strict', path);
}
