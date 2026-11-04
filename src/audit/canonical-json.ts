import { createHash } from 'node:crypto';

/**
 * Story 20.1 (AD-99): deterministic JSON for the audit hash chain. PURE.
 *
 * - object keys sorted (recursively, by UTF-16 code unit), no whitespace;
 * - `Date` -> ISO string with milliseconds, `BigInt` -> string;
 * - `undefined` is omitted from objects (and is `null` in an array, like JSON);
 * - `null` is kept;
 * - numbers must be finite (the audit payload validator additionally restricts
 *   `before`/`after` to integers: `jsonb` normalizes numbers, money goes as string).
 */
export function canonicalJSON(value: unknown): string {
  return serialize(value);
}

function serialize(v: unknown): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'string':
      return JSON.stringify(v);
    case 'boolean':
      return v ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(v)) {
        throw new TypeError('canonicalJSON: non-finite number');
      }
      return JSON.stringify(v);
    case 'bigint':
      return JSON.stringify(v.toString());
    case 'undefined':
      return 'null';
    case 'object':
      break;
    default:
      throw new TypeError(`canonicalJSON: unsupported type ${typeof v}`);
  }
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) {
      throw new TypeError('canonicalJSON: invalid Date');
    }
    return JSON.stringify(v.toISOString());
  }
  if (Array.isArray(v)) {
    return `[${v.map(serialize).join(',')}]`;
  }
  const obj = v as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(obj).sort()) {
    if (obj[key] === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${serialize(obj[key])}`);
  }
  return `{${parts.join(',')}}`;
}

/** Genesis `prevHash`: 64 zeros. */
export const GENESIS_HASH = '0'.repeat(64);

export const AUDIT_ACTOR_TYPES = [
  'ADMIN',
  'SYSTEM',
  'CUSTOMER',
  'ANON',
] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

/** The content covered by the hash (everything except `hashVersion`, `prevHash` and `hash`). */
export interface AuditHashContent {
  seq: number;
  occurredAt: Date;
  actorType: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  before: unknown;
  after: unknown;
  reason: string | null;
  requestId: string | null;
  /** As Postgres prints it (`host(ip)`), see AuditService. */
  ip: string | null;
}

/** `hash = hex(SHA-256(prevHash || canonicalJSON({...content})))`, hashVersion 1. */
export function computeAuditHash(
  prevHash: string,
  c: AuditHashContent,
): string {
  const body = canonicalJSON({
    seq: c.seq,
    occurredAt: c.occurredAt,
    actorType: c.actorType,
    actorId: c.actorId ?? null,
    action: c.action,
    entityType: c.entityType,
    entityId: c.entityId,
    before: c.before ?? null,
    after: c.after ?? null,
    reason: c.reason ?? null,
    requestId: c.requestId ?? null,
    ip: c.ip ?? null,
  });
  return createHash('sha256')
    .update(prevHash + body, 'utf8')
    .digest('hex');
}
