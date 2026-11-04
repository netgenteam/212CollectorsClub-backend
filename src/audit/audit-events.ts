import type { AuditEventInput } from './audit.service.js';
import { Logger } from '@nestjs/common';
import {
  AuditPayloadError,
  auditPayloadMode,
  toAuditPayload,
} from './audit-payload.js';
import type { AuditPayload } from './audit-payload.js';

/**
 * Story 20.5: small builders shared by the emitters. Payloads always go through
 * `toAuditPayload` (Decimal / Date / BigInt -> string): an `AuditPayloadError` on a money
 * column would otherwise turn a sale into a 500.
 */

/** The admin behind an HTTP request (`request.user`). */
export const adminActor = (
  admin: { id: string } | null | undefined,
): Pick<AuditEventInput, 'actorType' | 'actorId'> =>
  admin
    ? { actorType: 'ADMIN', actorId: admin.id }
    : { actorType: 'SYSTEM', actorId: null };

export const SYSTEM_ACTOR: Pick<AuditEventInput, 'actorType' | 'actorId'> = {
  actorType: 'SYSTEM',
  actorId: null,
};

const logger = new Logger('AuditEvents');

/**
 * `toAuditPayload` that never takes a business action down in PRODUCTION: a value that cannot be
 * serialized (an invalid Date, a function...) is a bug of the emitter, so in lenient mode it
 * becomes a marker and an error log line; in strict mode (dev, tests) it is thrown so the test
 * of the call site fails.
 */
function safePayload(v: Record<string, unknown>): AuditPayload {
  try {
    return toAuditPayload(v);
  } catch (err) {
    if (auditPayloadMode() === 'lenient' && err instanceof AuditPayloadError) {
      logger.error(
        `audit payload could not be built; marker used: ${err.message}`,
      );
      return { payloadError: 'UNSERIALIZABLE' };
    }
    throw err;
  }
}

/** Builds a payload from a plain object holding Prisma values (Decimal, Date, bigint). */
export const payload = (v: Record<string, unknown>): AuditPayload =>
  safePayload(v);

/** Keeps only the keys whose value differs (before/after of an update). */
export function diffPayload(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  keys: readonly string[],
  same: (a: unknown, b: unknown) => boolean = Object.is,
): { before: AuditPayload; after: AuditPayload; changed: string[] } {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  const changed: string[] = [];
  for (const k of keys) {
    if (same(before[k], after[k])) continue;
    b[k] = before[k] ?? null;
    a[k] = after[k] ?? null;
    changed.push(k);
  }
  return { before: safePayload(b), after: safePayload(a), changed };
}

/** `ORDER_STATUS_CHANGED` for an order moved by `guardedOrderStatusTransition`. */
export function orderStatusChangedEvent(p: {
  actor: Pick<AuditEventInput, 'actorType' | 'actorId'>;
  orderId: string;
  from: string;
  to: string;
  extra?: Record<string, unknown>;
  reason?: string | null;
}): AuditEventInput {
  return {
    ...p.actor,
    action: 'ORDER_STATUS_CHANGED',
    entityType: 'Order',
    entityId: p.orderId,
    before: { status: p.from },
    after: payload({ status: p.to, ...p.extra }),
    reason: p.reason ?? null,
  };
}
