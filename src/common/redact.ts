import { newIdDocInTextRegex } from './id-doc-pattern.js';

/**
 * Story 20.2 (AD-95, FR-129, NFR-20.5): redaction of personal data and secrets
 * before anything reaches a log. Two layers: (1) object KEYS that name a
 * sensitive field have their value replaced; (2) STRINGS (values, messages,
 * stacks, e.g. a Prisma error echoing a value) have any cedula-shaped token
 * replaced. Never mutates its input.
 */
export const REDACTED = '[REDACTED]';
export const REDACTED_ID_DOC = '[REDACTED_ID]';

/** Keys whose value is never logged (AD-95 + `secret`, so a keyring never leaks). */
export const SENSITIVE_KEY =
  /idDoc|buyerId|recipientId|cedula|password|token|authorization|cookie|secret/i;

/**
 * Field NAMES that carry a cedula or its derivatives (plain, `...Enc`, `...Blind`, buyer, recipient).
 * Kept next to SENSITIVE_KEY: the same family, applied to text instead of object keys.
 */
const NAME = String.raw`[A-Za-z0-9_$.]*(?:id_?doc|cedula|buyer_?id|recipient_?id)[A-Za-z0-9_$]*`;
/** A quote (plain, escaped for JSON-in-JSON, or a backtick) or nothing. */
const Q = String.raw`\\*["'\`]?`;
/** The value after the name: quoted (may hold spaces) or a bare token. Never eats an already redacted marker. */
const VALUE = String.raw`(?!\[REDACTED)(?:\\*"[^"]*"|\\*'[^']*'|\\*\`[^\`]*\`|[^\s,;)}\]"'\`\\&]+)`;
/**
 * `recipientIdDoc: 12345678`, `recipientIdDoc=V-1`, `{"recipientIdDoc":"1234"}`,
 * `{\"recipientIdDoc\":\"1234\"}`, `recipientIdDocEnc => v1:...`: name, optional quote,
 * `:` / `=` / `=>`, then the value. The label is kept (useful to read the log), the value is not.
 */
const FIELD_VALUE = new RegExp(
  // `idDoc[0]=…` / `idDoc[a]=…` (array / query-string style) and a URL-encoded separator
  // (`idDoc%3D…`, `%3A`) are the same thing as `idDoc=…`.
  `(${NAME}(?:\\[[^\\]]{0,20}\\])*)(${Q}\\s*(?::|=>?|%3[dDaA])\\s*)(\\(?)(${VALUE})`,
  'gi',
);
/**
 * A label in prose followed by the number: `ci: 12345678`, `C.I. V-12345678`, `cedula 12345678`
 * (no colon), `RIF J-12345678-9`, `pasaporte AB123456`. The label stays, the value goes.
 */
const LABEL_VALUE = new RegExp(
  String.raw`(?<![\w])(c\.?\s?i\.?|c[eé]dula|ced\.?|rif|pasaporte)(\s*[:=#]?\s*)((?:[VEJGP][\s.-]?)?\d(?:[.\s-]?\d){4,10}(?:-\d)?|P[\s.-]?[A-Z]{1,3}\d{4,10})(?![\w])`,
  'gi',
);
const INVISIBLE = new RegExp('[\u200B-\u200D\u2060\uFEFF]', 'g');
/**
 * Postgres unique/foreign key detail: `Key (recipientIdDoc)=(12345678)` and the multi-column form
 * `Key (customerId, recipientIdDocBlind)=(<uuid>, abc...)`: if any column of the list is sensitive,
 * the whole list of values goes.
 */
const PG_KEY = /(Key \(([^)]*)\)=\()([^)]*)(\))/gi;
const SENSITIVE_NAME = new RegExp(NAME, 'i');
/** A stored ciphertext: `v<N>:<iv>:<tag>:<ct>` (never useful in a log, and it identifies the row). */
const ENC_VALUE =
  /(?<![\w:])v\d{1,4}:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]{1,400}/g;
export const REDACTED_ENC = '[REDACTED_ENC]';

const MAX_DEPTH = 8;
const MAX_NODES = 2_000;
/** Cheap gate: every cedula token needs 5 digits in a row or a grouped `d.ddd.ddd`. */
const MAYBE_ID =
  /\d{5}|\d[.\s]\d{3}[.\s]\d{3}|[pP][\s.-][A-Za-z0-9]{5}|iddoc|id_doc|cedula|buyerid|buyer_id|recipientid|recipient_id|v\d{1,4}:/i;
/** Any non-ASCII character: the only strings that can hide a cedula behind NFKC / zero-width tricks. */
// eslint-disable-next-line no-control-regex
const NON_ASCII = /[^\x00-\x7F]/;

/** Replaces cedula-shaped tokens in free text. A line without 5 digits skips the regex. */
export function redactString(input: string): string {
  if (input.length === 0) return input;
  // `Ｖ-７０１２３４５６` (fullwidth) and `V<ZWSP>-…` are the same cedula once folded: look at the
  // folded text, and if it holds one, return the folded-and-redacted text (never the original).
  if (NON_ASCII.test(input)) {
    const folded = input.normalize('NFKC').replace(INVISIBLE, '');
    if (folded !== input) {
      const r = redactAscii(folded);
      if (r !== folded) return r;
    }
  }
  return redactAscii(input);
}

function redactAscii(input: string): string {
  if (input.length === 0 || !MAYBE_ID.test(input)) return input;
  // 1) by field name (catches values that have no cedula shape: `recipientIdDoc: 12345678`).
  // A bare word with no digit (`iddoc:backfill started`, `idDocType=V`) is not a cedula: kept.
  let out = input.replace(
    FIELD_VALUE,
    (m: string, name: string, sep: string, open: string, value: string) =>
      /^[\\"'`]/.test(value) || /\d/.test(value)
        ? `${name}${sep}${open}${REDACTED}`
        : m,
  );
  // 1b) a label in prose followed by the number (`ci: …`, `C.I. …`, `cedula …`)
  out = out.replace(
    LABEL_VALUE,
    (_m, label: string, sep: string) => `${label}${sep}${REDACTED_ID_DOC}`,
  );
  out = out.replace(
    PG_KEY,
    (m, head: string, cols: string, vals: string, tail: string) =>
      SENSITIVE_NAME.test(cols) ? `${head}${REDACTED}${tail}` : m,
  );
  // 2) stored ciphertext, 3) anything shaped like a cedula
  return out
    .replace(ENC_VALUE, REDACTED_ENC)
    .replace(newIdDocInTextRegex(), REDACTED_ID_DOC);
}

interface Budget {
  nodes: number;
  seen: WeakSet<object>;
}

function walk(value: unknown, depth: number, b: Budget): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') {
    return typeof value === 'function' || typeof value === 'symbol'
      ? String(value.toString())
      : value;
  }
  if (value instanceof Date || Buffer.isBuffer(value)) return value;
  if (b.seen.has(value)) return '[Circular]';
  if (depth >= MAX_DEPTH || ++b.nodes > MAX_NODES) return '[Truncated]';
  b.seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((v) => walk(v, depth + 1, b));
    if (value instanceof Error) {
      const out: Record<string, unknown> = {
        name: value.name,
        message: redactString(value.message),
      };
      if (value.stack) out.stack = redactString(value.stack);
      for (const k of Object.keys(value)) {
        if (!(k in out)) out[k] = fieldOf(value, k, depth, b);
      }
      return out;
    }
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value)) out[k] = fieldOf(value, k, depth, b);
    return out;
  } finally {
    // Siblings may legitimately share a node; only an ancestor is a cycle.
    b.seen.delete(value);
  }
}

function fieldOf(obj: object, key: string, depth: number, b: Budget): unknown {
  if (SENSITIVE_KEY.test(key)) return REDACTED;
  try {
    return walk((obj as Record<string, unknown>)[key], depth + 1, b);
  } catch {
    return '[Unreadable]';
  }
}

/** Deep copy of `value` with sensitive keys masked and cedula-shaped strings replaced. */
export function redactDeep<T = unknown>(value: T): T {
  return walk(value, 0, { nodes: 0, seen: new WeakSet() }) as T;
}
