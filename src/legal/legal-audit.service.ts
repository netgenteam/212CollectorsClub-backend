import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import type { LegalAuditAction } from '../generated/prisma/enums.js';
import { AuditEventError } from '../audit/audit.service.js';
import type {
  AuditCollector,
  AuditEventInput,
} from '../audit/audit.service.js';
import { toAuditPayload } from '../audit/audit-payload.js';
import type { LegalActor } from './legal-admin.common.js';

/** The audit `meta` column is CHECKed to <= 2048 bytes; stay below it. */
export const AUDIT_META_MAX_BYTES = 1800;
export const DRAFT_EDIT_COALESCE_MINUTES = 10;

export interface LegalAuditInput {
  documentId: string | null;
  action: LegalAuditAction;
  /** `null` = a system action with no admin behind it (the Story 19.3 seed). */
  actor: LegalActor | null;
  versionNumber?: number | null;
  /** Never the document body. */
  meta?: Record<string, unknown>;
  /**
   * Story 20.5: extra, audit-safe facts for the immutable event (not stored in `meta`):
   * for `PUBLISHED` the `slug` and the `contentHash` (SHA-256 of the body, never the body);
   * for `IDENTITY_UPDATED` the `before` / `after` of the CHANGED seller fields (the seller's
   * own public data, allowed by the catalog's `publicFields` for that action only).
   */
  event?: {
    slug?: string;
    contentHash?: string;
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
  };
}

/**
 * Story 20.5 (AD-99): the only two Legal actions that belong to the immutable catalog.
 * `DRAFT_EDITED`, `DRAFT_CREATED`, `DRAFT_DISCARDED`, `RESTORED` stay in `Legal_Audit_Logs` only.
 */
export function legalAuditEvent(
  input: LegalAuditInput,
): AuditEventInput | null {
  const actor: Pick<AuditEventInput, 'actorType' | 'actorId'> = input.actor
    ? { actorType: 'ADMIN', actorId: input.actor.id }
    : { actorType: 'SYSTEM', actorId: null };
  if (input.action === 'PUBLISHED') {
    const m = input.meta ?? {};
    const docId = input.documentId ?? 'unknown';
    return {
      ...actor,
      action: 'LEGAL_DOC_PUBLISHED',
      entityType: 'LegalDocument',
      entityId: docId,
      after: toAuditPayload({
        documentId: docId,
        slug: input.event?.slug,
        version: input.versionNumber ?? null,
        isSubstantial: m.isSubstantial ?? null,
        effectiveFrom: m.effectiveFrom ?? null,
        draftRevision: m.draftRevision ?? null,
        restoredFromVersion: m.restoredFromVersion ?? null,
        contentHash: input.event?.contentHash,
      }),
    };
  }
  if (input.action === 'IDENTITY_UPDATED') {
    return {
      ...actor,
      action: 'SELLER_IDENTITY_UPDATED',
      entityType: 'SellerIdentity',
      entityId: 'default',
      before: toAuditPayload(input.event?.before ?? {}),
      after: toAuditPayload(input.event?.after ?? {}),
    };
  }
  return null;
}

type Tx = Pick<Prisma.TransactionClient, '$queryRaw' | 'legalAuditLog'>;

/**
 * Story 19.2 (AD-90, FR-108): the append-only audit trail. `record` takes the
 * TRANSACTION of the action (never the root client), so a rollback leaves no
 * row. There is no update/delete here (the database rejects them anyway).
 */
@Injectable()
export class LegalAuditService {
  /** Keeps `meta` below the DB limit: drops the longest strings, then falls back to a marker. */
  static boundMeta(meta: Record<string, unknown>): Prisma.InputJsonObject {
    const fits = (m: unknown) =>
      Buffer.byteLength(JSON.stringify(m), 'utf8') <= AUDIT_META_MAX_BYTES;
    if (fits(meta)) return meta as Prisma.InputJsonObject;
    const cut: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(meta)) {
      cut[k] = typeof v === 'string' && v.length > 120 ? v.slice(0, 120) : v;
    }
    return fits(cut) ? (cut as Prisma.InputJsonObject) : { truncated: true };
  }

  /**
   * `collector` (Story 20.5): the `AuditService.transaction` collector of the same
   * transaction. REQUIRED for `PUBLISHED` and `IDENTITY_UPDATED` (they also emit their event
   * to the immutable log; omitting it is a programming error, not a silent gap).
   */
  async record(
    tx: Tx,
    input: LegalAuditInput,
    collector?: AuditCollector,
  ): Promise<void> {
    const event = legalAuditEvent(input);
    if (event && !collector) {
      throw new AuditEventError(
        `${input.action} needs the audit collector of its transaction`,
      );
    }
    await tx.legalAuditLog.create({
      data: {
        documentId: input.documentId,
        action: input.action,
        adminUserId: input.actor?.id ?? null,
        adminEmail: input.actor?.email ?? null,
        versionNumber: input.versionNumber ?? null,
        meta: LegalAuditService.boundMeta(input.meta ?? {}),
      },
    });
    // Collected, flushed last by the owner of the transaction.
    if (event && collector) collector.add(event);
  }

  /**
   * A70 coalescence by OMISSION (the table is append-only, the previous row
   * cannot be updated): inserts `DRAFT_EDITED` only when the same admin has no
   * other one on that document in the last 10 minutes. Callers invoke it AFTER
   * taking the draft row's lock (the UPDATE), so concurrent edits serialize
   * here and cannot both insert. Returns whether a row was written.
   */
  async recordDraftEdited(
    tx: Tx,
    input: Omit<LegalAuditInput, 'action' | 'actor'> & {
      documentId: string;
      actor: LegalActor;
    },
  ): Promise<boolean> {
    const [{ recent }] = await tx.$queryRaw<{ recent: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM "Legal_Audit_Logs"
        WHERE "documentId" = ${input.documentId}::uuid
          AND "action" = 'DRAFT_EDITED'::"LegalAuditAction"
          AND "adminUserId" = ${input.actor.id}::uuid
          AND "createdAt" > now() - make_interval(mins => ${DRAFT_EDIT_COALESCE_MINUTES}::int)
      ) AS "recent"`;
    if (recent) return false;
    await this.record(tx, { ...input, action: 'DRAFT_EDITED' });
    return true;
  }
}
