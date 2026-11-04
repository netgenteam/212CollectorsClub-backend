import { newIdDocInTextRegex } from './id-doc-pattern.js';
import { redactedPrefix } from './redact-cut.js';

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
 *
 * NOT a regex with a leading `[A-Za-z0-9_$.]*`: that star tries every start of a long run and, for
 * `'idDoc'.repeat(n)`, made the redactor CUBIC (measured, dev machine: 4 000 characters 6.2 s,
 * 8 000 characters 49 s of blocked event loop, on every log line). The name is found in ONE linear
 * pass instead: a maximal run of name characters (`NAME_RUN`) that holds a keyword (`NAME_KEYWORD`).
 * The label keeps the whole run (`prefix.idDocEnc` stays readable).
 */
const NAME_RUN = /[A-Za-z0-9_$.]+/g;
const NAME_KEYWORD = /id_?doc|cedula|buyer_?id|recipient_?id/i;
/** A quote (plain, escaped for JSON-in-JSON, or a backtick) or nothing. */
const Q = String.raw`\\*["'\`]?`;
/**
 * What follows the name: `[0]` style subscripts, then `: ` / `=` / `=>` / a URL-encoded separator
 * (`%3D`, `%3A`), then an optional `(`. `recipientIdDoc: 12345678`, `recipientIdDoc=V-1`,
 * `{"recipientIdDoc":"1234"}`, `{\"recipientIdDoc\":\"1234\"}`, `recipientIdDocEnc => v1:...`: the
 * label is kept (useful to read the log), the value is not. Sticky: matched exactly at the end of a
 * name run.
 */
const FIELD_HEAD = new RegExp(
  `((?:\\[[^\\]]{0,20}\\])*)(${Q}\\s*(?::|=>?|%3[dDaA])\\s*)(\\(?)`,
  'y',
);
/**
 * The value after that: quoted (may hold spaces; a quote that is never closed (a cut line, a
 * truncated message) takes the REST of the text: what follows an opened quote after a sensitive
 * name is the value) ...
 */
const QUOTED_VALUE = /\\*"[^"]*(?:"|$)|\\*'[^']*(?:'|$)|\\*`[^`]*(?:`|$)/y;
/** ... or a bare token. */
const BARE_VALUE = /[^\s,;)}\]"'`\\&]+/y;
/**
 * A label in prose followed by the number: `ci: 12345678`, `C.I. V-12345678`, `cedula 12345678`
 * (no colon), `RIF J-12345678-9`, `pasaporte AB123456`. The label stays, the value goes.
 * The separator is `\s*(?:[:=#]\s*)?` and NOT `\s*[:=#]?\s*`: two adjacent `\s*` split a run of
 * spaces in n ways (`'ci' + ' '.repeat(n)` was quadratic).
 */
const LABEL_VALUE = new RegExp(
  String.raw`(?<![\w])(c\.?\s?i\.?|c[eé]dula|ced\.?|rif|pasaporte)(\s*(?:[:=#]\s*)?)((?:[VEJGP][\s.-]?)?\d(?:[.\s-]?\d){4,10}(?:-\d)?|P[\s.-]?[A-Z]{1,3}\d{4,10})(?![\w])`,
  'gi',
);
const INVISIBLE = new RegExp('[\u200B-\u200D\u2060\uFEFF]', 'g');
/**
 * Postgres unique/foreign key detail: `Key (recipientIdDoc)=(12345678)` and the multi-column form
 * `Key (customerId, recipientIdDocBlind)=(<uuid>, abc...)`: if any column of the list is sensitive,
 * the whole list of values goes. Scanned by hand: the regex `Key \(([^)]*)\)=\(([^)]*)\)` rescans to
 * the end of the text from every `Key (` when there is no `)` (quadratic). The position of the next
 * `)` is remembered, so every character is looked at a bounded number of times.
 */
const PG_KEY_HEAD = /Key \(/gi;
function redactPgKeys(input: string): string {
  PG_KEY_HEAD.lastIndex = 0;
  let out = '';
  let pos = 0;
  let found = -2; // result of the last indexOf(')'): -2 none yet, -1 no ')' left
  let foundFrom = 0;
  let noKeywordEnd = -1;
  const nextClose = (from: number): number => {
    if (found === -1 && from >= foundFrom) return -1;
    if (found >= from && from >= foundFrom) return found;
    found = input.indexOf(')', from);
    foundFrom = from;
    return found;
  };
  let m: RegExpExecArray | null;
  while ((m = PG_KEY_HEAD.exec(input)) !== null) {
    const colsStart = m.index + m[0].length;
    const colsEnd = nextClose(colsStart);
    if (colsEnd < 0) break; // no ')' after: no later `Key (` can match either
    if (!input.startsWith('=(', colsEnd + 1)) continue;
    const valsStart = colsEnd + 3;
    const valsEnd = nextClose(valsStart);
    if (valsEnd < 0) break;
    // Same closing `)` and no sensitive column the first time: a later `Key (` before it holds a
    // subset of that text, so it cannot hold one either (and is not scanned again).
    if (colsEnd === noKeywordEnd) continue;
    if (!NAME_KEYWORD.test(input.slice(colsStart, colsEnd))) {
      noKeywordEnd = colsEnd;
      continue;
    }
    out += `${input.slice(pos, valsStart)}${REDACTED}`;
    pos = valsEnd;
    PG_KEY_HEAD.lastIndex = valsEnd;
  }
  return pos === 0 ? input : out + input.slice(pos);
}
/** A stored ciphertext: `v<N>:<iv>:<tag>:<ct>` (never useful in a log, and it identifies the row). */
const ENC_VALUE =
  /(?<![\w:])v\d{1,4}:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]{1,400}/g;
export const REDACTED_ENC = '[REDACTED_ENC]';

const MAX_DEPTH = 8;
const MAX_NODES = 2_000;
/**
 * Bounds (this runs on EVERY log line in the main thread). The name-of-field scan used to be CUBIC
 * (`'idDoc'.repeat(n)`: 4 000 characters 6.2 s, 8 000 characters 49 s; fixed, see `NAME_RUN`) and the
 * cedula regexes were quadratic on one long unbroken run of digits (100 000 digits 3.9-5.3 s). Every
 * pass is now linear or bounded (`test/guard-redact-bounds.perf.spec.ts` fuzzes the shapes and fixes
 * a ceiling), and the caps stay as a second line of defence: a longer string is cut (the cut tail is
 * never logged, so it cannot leak either) and one `redactDeep` call spends at most `MAX_TOTAL_CHARS`
 * characters on strings; the rest becomes a marker. Object keys are cut at `MAX_KEY_CHARS`. A cut is
 * made AFTER redacting (`redact-cut.ts`): a cedula that straddles the cut leaves no prefix behind.
 */
export const MAX_STRING_CHARS = 8_192;
/**
 * Only a string with a run of 64+ digits/dots is cut and spends the budget (`1111...`,
 * `111.111.111...`, the shape that was quadratic). A long ordinary message (words, sentences) is
 * NOT cut: the passes are linear on it (`test/guard-redact-bounds.perf.spec.ts`).
 */
const RISKY_RUN = /[\d.]{64}/;
export const MAX_TOTAL_CHARS = 32_768;
export const MAX_KEY_CHARS = 256;
/** Cheap gate: every cedula token needs 5 digits in a row or a grouped `d.ddd.ddd`. */
const MAYBE_ID =
  /\d{5}|\d[.\s]\d{3}[.\s]\d{3}|[pP][\s.-][A-Za-z0-9]{5}|iddoc|id_doc|cedula|buyerid|buyer_id|recipientid|recipient_id|v\d{1,4}:/i;
/** Any non-ASCII character: the only strings that can hide a cedula behind NFKC / zero-width tricks. */
// eslint-disable-next-line no-control-regex
const NON_ASCII = /[^\x00-\x7F]/;

/** Replaces cedula-shaped tokens in free text. A line without 5 digits skips the regex. */
export function redactString(input: string): string {
  if (input.length === 0) return input;
  if (input.length > MAX_STRING_CHARS && RISKY_RUN.test(input)) {
    // Redact BEFORE cutting (a cedula straddling the cut must not leave `V-123456` behind).
    return `${redactedPrefix(input, MAX_STRING_CHARS, redactWhole)}[TRUNCATED:${input.length - MAX_STRING_CHARS} chars]`;
  }
  return redactWhole(input);
}

/** The redaction of a text as it is (no cut): fold, then the patterns. */
function redactWhole(input: string): string {
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

/**
 * `name: value` pairs where the name is a cedula field: one linear pass (see `NAME_RUN`). A quoted
 * value is always replaced (and consumed). A bare value is replaced only when it holds a digit
 * (`iddoc:backfill started`, `idDocType=V` are not a cedula): when it does not, the pass goes on
 * right after the NAME, so a later name inside that token is still seen. The end of the bare token
 * and its last digit are remembered, so that rescan costs O(1) per name, not O(token).
 */
function redactFieldValues(input: string): string {
  NAME_RUN.lastIndex = 0;
  let out = '';
  let pos = 0;
  let tokFrom = -1; // the last bare token seen: [tokFrom, tokEnd), its last digit at lastDigit (or -1)
  let tokEnd = -1;
  let lastDigit = -1;
  let m: RegExpExecArray | null;
  while ((m = NAME_RUN.exec(input)) !== null) {
    const nameEnd = m.index + m[0].length;
    if (!NAME_KEYWORD.test(m[0])) continue;
    FIELD_HEAD.lastIndex = nameEnd;
    const h = FIELD_HEAD.exec(input);
    if (h === null) continue;
    const vs = nameEnd + h[0].length; // where the value starts
    if (input.startsWith('[REDACTED', vs)) continue; // already redacted: never eat a marker
    let ve: number;
    QUOTED_VALUE.lastIndex = vs;
    const q = QUOTED_VALUE.exec(input);
    if (q !== null) {
      ve = vs + q[0].length;
    } else {
      if (!(vs >= tokFrom && vs < tokEnd)) {
        BARE_VALUE.lastIndex = vs;
        const t = BARE_VALUE.exec(input);
        if (t === null) continue;
        tokFrom = vs;
        tokEnd = vs + t[0].length;
        lastDigit = tokEnd - 1;
        while (lastDigit >= vs && !isDigit(input.charCodeAt(lastDigit))) {
          lastDigit -= 1;
        }
      }
      if (lastDigit < vs) continue; // a bare word with no digit: kept
      ve = tokEnd;
    }
    out += `${input.slice(pos, vs)}${REDACTED}`;
    pos = ve;
    NAME_RUN.lastIndex = ve;
  }
  return pos === 0 ? input : out + input.slice(pos);
}

const isDigit = (c: number): boolean => c >= 48 && c <= 57;

function redactAscii(input: string): string {
  if (input.length === 0 || !MAYBE_ID.test(input)) return input;
  // 1) by field name (catches values that have no cedula shape: `recipientIdDoc: 12345678`).
  // A bare word with no digit (`iddoc:backfill started`, `idDocType=V`) is not a cedula: kept.
  let out = redactFieldValues(input);
  // 1b) a label in prose followed by the number (`ci: …`, `C.I. …`, `cedula …`)
  out = out.replace(
    LABEL_VALUE,
    (_m, label: string, sep: string) => `${label}${sep}${REDACTED_ID_DOC}`,
  );
  out = redactPgKeys(out);
  // 2) stored ciphertext, 3) anything shaped like a cedula
  return out
    .replace(ENC_VALUE, REDACTED_ENC)
    .replace(newIdDocInTextRegex(), REDACTED_ID_DOC);
}

interface Budget {
  nodes: number;
  chars: number;
  seen: WeakSet<object>;
}

function walk(value: unknown, depth: number, b: Budget): unknown {
  if (typeof value === 'string') {
    if (value.length > 64 && RISKY_RUN.test(value)) {
      b.chars += Math.min(value.length, MAX_STRING_CHARS);
      if (b.chars > MAX_TOTAL_CHARS) return '[Truncated]';
    }
    return redactString(value);
  }
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
        message: walk(String(value.message), depth + 1, b),
      };
      if (value.stack) out.stack = walk(String(value.stack), depth + 1, b);
      for (const k of Object.keys(value)) {
        if (!(k in out)) out[k] = fieldOf(value, k, depth, b);
      }
      return out;
    }
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value)) {
      // The key text is redacted too (a cedula used as a key), and cut AFTER redacting.
      const shown =
        k.length > MAX_KEY_CHARS
          ? `${redactedPrefix(k, MAX_KEY_CHARS, redactWhole)}...`
          : redactWhole(k);
      out[shown] = fieldOf(value, k, depth, b);
    }
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
  return walk(value, 0, { nodes: 0, chars: 0, seen: new WeakSet() }) as T;
}
