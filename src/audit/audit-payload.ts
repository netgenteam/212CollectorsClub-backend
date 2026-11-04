import { pgText } from './audit-normalize.js';

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
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
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
  re: RegExp;
  accept?: (match: string) => boolean;
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
  { name: 'EMAIL', re: /[^\s@]+@[^\s@]+\.[^\s@]+/g },
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
        String.raw`\b(?:api[_-]?key|access[_-]?token|token)\s*[:=]\s*(?=\S*\d)\S{8,}`,
      ].join('|'),
      'gi',
    ),
  },
  {
    name: 'PHONE',
    re: new RegExp(
      [
        String.raw`(?<![\w+])\+\d{1,3}[\s.()-]*\d(?:[\s.()-]*\d){6,11}(?!\w)`,
        String.raw`(?<![\w.+-])(?:58[\s.-]?0?|0)(?:4(?:12|14|16|24|26)|2\d\d)[\s.-]?\d{3}[\s.-]?\d{4}(?!\w)`,
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
export function redactText(s: string): { text: string; hits: string[] } {
  const hits: string[] = [];
  let text = s;
  for (const d of DETECTORS) {
    text = text.replace(d.re, (m) => {
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

// ─── the walk ─────────────────────────────────────────────────────────────

const MAX_DEPTH = 8;

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
): SanitizeResult {
  const issues: PayloadIssue[] = [];
  const violation = (path: string, why: string): void => {
    if (mode === 'strict') throw new AuditPayloadError(path, why);
    issues.push({ path, why });
  };

  const text = (s: string, path: string): string => {
    const clean = pgText(s);
    const { text: out, hits } = redactText(clean);
    if (hits.length > 0) {
      violation(path, `looks like ${labels(hits)}`);
      return out;
    }
    return clean;
  };

  const walk = (v: unknown, path: string, depth: number): AuditPayload => {
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
          : walk(x, `${path}[${i}]`, depth + 1),
      );
    }
    if (
      typeof v === 'object' &&
      (Object.getPrototypeOf(v) === Object.prototype ||
        Object.getPrototypeOf(v) === null)
    ) {
      const out: { [key: string]: AuditPayload } = {};
      for (const [k, x] of Object.entries(v)) {
        let key = pgText(k);
        const kPath = `${path}.${key}`;
        const keyHits = redactText(key).hits;
        if (keyHits.length > 0) {
          violation(kPath, `key looks like ${labels(keyHits)}`);
          key = redactText(key).text;
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
        const kv = keyViolation(key);
        if (x === undefined) {
          violation(kPath, 'undefined (omit the key)');
          continue;
        } else if (kv !== null) {
          violation(kPath, kv);
          item = '[REDACTED:KEY]';
        } else {
          item = walk(x, kPath, depth + 1);
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
    throw new AuditPayloadError(
      path,
      `unsupported value (${typeof v}); Date/BigInt/class instances are not allowed`,
    );
  };

  return { value: walk(value, rootPath, 0), issues };
}

/** Strict check (throws `AuditPayloadError`); kept for callers and tests that only validate. */
export function assertAuditPayload(
  value: unknown,
  path = '$',
): asserts value is AuditPayload {
  sanitizeAuditPayload(value, 'strict', path);
}
