import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  IdentityResponseDto,
  UpdateIdentityDto,
} from './dto/legal-admin.dto.js';
import { legalTx, type LegalActor } from './legal-admin.common.js';
import { LegalAuditService } from './legal-audit.service.js';

const FIELDS = [
  'legalName',
  'rif',
  'fiscalAddress',
  'contactEmail',
  'phone',
] as const;
type Field = (typeof FIELDS)[number];
type IdentityRow = Record<Field, string | null>;

const toDto = (r: IdentityRow): IdentityResponseDto => {
  const missing = (['legalName', 'rif'] as const).filter((f) => !r[f]);
  return { ...r, complete: missing.length === 0, missing: [...missing] };
};

/**
 * Story 19.2 (FR-111): the seller identity singleton. PUT changes only the
 * fields present in the body (`null`/blank clears one); it audits
 * `IDENTITY_UPDATED` in the same transaction with the NAMES of the fields that
 * changed (never their values). No change = no write and no audit row.
 */
@Injectable()
export class SellerIdentityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: LegalAuditService,
  ) {}

  async get(): Promise<IdentityResponseDto> {
    const [row] = await this.prisma.$queryRaw<IdentityRow[]>`
      SELECT "legalName", "rif", "fiscalAddress", "contactEmail", "phone"
      FROM "Seller_Identity_Settings" WHERE "id" = 'default'`;
    return toDto(
      row ?? {
        legalName: null,
        rif: null,
        fiscalAddress: null,
        contactEmail: null,
        phone: null,
      },
    );
  }

  async update(
    dto: UpdateIdentityDto,
    actor: LegalActor,
  ): Promise<IdentityResponseDto> {
    return legalTx(this.prisma, async (tx, budget) => {
      await tx.$executeRaw`
        INSERT INTO "Seller_Identity_Settings" ("id", "updatedAt") VALUES ('default', now())
        ON CONFLICT ("id") DO NOTHING`;
      const [cur] = await tx.$queryRaw<IdentityRow[]>`
        SELECT "legalName", "rif", "fiscalAddress", "contactEmail", "phone"
        FROM "Seller_Identity_Settings" WHERE "id" = 'default' FOR UPDATE`;
      await budget.release();
      const next: IdentityRow = { ...cur };
      const changed: Field[] = [];
      for (const f of FIELDS) {
        if (dto[f] === undefined) continue;
        const v = dto[f] ?? null;
        if (v !== cur[f]) {
          next[f] = v;
          changed.push(f);
        }
      }
      if (changed.length === 0) return toDto(cur);
      await tx.$executeRaw`
        UPDATE "Seller_Identity_Settings"
        SET "legalName" = ${next.legalName}, "rif" = ${next.rif},
            "fiscalAddress" = ${next.fiscalAddress}, "contactEmail" = ${next.contactEmail},
            "phone" = ${next.phone}, "updatedAt" = now(), "updatedById" = ${actor.id}::uuid
        WHERE "id" = 'default'`;
      await this.audit.record(tx, {
        documentId: null,
        action: 'IDENTITY_UPDATED',
        actor,
        meta: { changedFields: changed },
      });
      return toDto(next);
    });
  }
}
