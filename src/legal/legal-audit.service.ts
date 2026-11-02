import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import type { LegalAuditAction } from '../generated/prisma/enums.js';
import type { LegalActor } from './legal-admin.common.js';

/** The audit `meta` column is CHECKed to <= 2048 bytes; stay below it. */
export const AUDIT_META_MAX_BYTES = 1800;
export const DRAFT_EDIT_COALESCE_MINUTES = 10;

export interface LegalAuditInput {
  documentId: string | null;
  action: LegalAuditAction;
  actor: LegalActor;
  versionNumber?: number | null;
  /** Never the document body. */
  meta?: Record<string, unknown>;
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

  async record(tx: Tx, input: LegalAuditInput): Promise<void> {
    await tx.legalAuditLog.create({
      data: {
        documentId: input.documentId,
        action: input.action,
        adminUserId: input.actor.id,
        adminEmail: input.actor.email,
        versionNumber: input.versionNumber ?? null,
        meta: LegalAuditService.boundMeta(input.meta ?? {}),
      },
    });
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
    input: Omit<LegalAuditInput, 'action'> & { documentId: string },
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
