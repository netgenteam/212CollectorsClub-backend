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

const MAX_DEPTH = 8;
const MAX_NODES = 2_000;
/** Cheap gate: every cedula token needs 5 digits in a row or a grouped `d.ddd.ddd`. */
const MAYBE_ID = /\d{5}|\d[.\s]\d{3}[.\s]\d{3}/;

/** Replaces cedula-shaped tokens in free text. A line without 5 digits skips the regex. */
export function redactString(input: string): string {
  if (input.length === 0 || !MAYBE_ID.test(input)) return input;
  return input.replace(newIdDocInTextRegex(), REDACTED_ID_DOC);
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
