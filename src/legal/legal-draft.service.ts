import { HttpStatus, Injectable } from '@nestjs/common';
import { ApiException } from '../common/api-exception.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  AdminLegalListItemDto,
  LegalDraftResponseDto,
  PutDraftDto,
} from './dto/legal-admin.dto.js';
import {
  findLegalDoc,
  legalDraftNotFound,
  legalDraftStale,
  legalTx,
  lockLegalDoc,
  type LegalActor,
} from './legal-admin.common.js';
import { LegalAuditService } from './legal-audit.service.js';
import { LegalMarkdownService } from './legal-markdown.service.js';
import { detectPlaceholders } from './legal-placeholders.js';
import { LEGAL_SLUGS } from './legal-slugs.js';

export interface DraftRow {
  bodyMd: string;
  revision: number;
  baseVersionNumber: number | null;
  restoredFromVersion: number | null;
  updatedAt: Date;
  updatedByEmail: string | null;
}

const toDto = (slug: string, r: DraftRow): LegalDraftResponseDto => ({
  slug,
  bodyMd: r.bodyMd,
  revision: r.revision,
  baseVersionNumber: r.baseVersionNumber,
  restoredFromVersion: r.restoredFromVersion,
  updatedAt: r.updatedAt.toISOString(),
  updatedByEmail: r.updatedByEmail,
  placeholders: detectPlaceholders(r.bodyMd),
});

/**
 * Story 19.2 (AD-90, FR-105/106/107): the single draft of each document.
 * Markdown is validated BEFORE the transaction (the validator can take 3 s and
 * must never run while a row lock is held). Optimistic concurrency is the
 * `revision` column: `INSERT … ON CONFLICT DO NOTHING` creates it,
 * `UPDATE … WHERE revision = base` edits it, 0 rows = 409 (never `upsert`).
 */
@Injectable()
export class LegalDraftService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly markdown: LegalMarkdownService,
    private readonly audit: LegalAuditService,
  ) {}

  /** `GET /admin/legal`: the six real documents with their state. */
  async list(): Promise<AdminLegalListItemDto[]> {
    const rows = await this.prisma.$queryRaw<
      {
        slug: string;
        title: string;
        kind: string;
        currentVersion: number | null;
        effectiveFrom: Date | null;
        latestVersion: number | null;
        draftRevision: number | null;
        draftUpdatedAt: Date | null;
        draftBody: string | null;
      }[]
    >`
      SELECT d."slug", d."title", d."kind"::text AS "kind",
             cur."versionNumber" AS "currentVersion", cur."effectiveFrom",
             (SELECT max(l."versionNumber") FROM "Legal_Document_Versions" l
               WHERE l."documentId" = d."id") AS "latestVersion",
             dr."revision" AS "draftRevision", dr."updatedAt" AS "draftUpdatedAt",
             dr."bodyMd" AS "draftBody"
      FROM "Legal_Documents" d
      LEFT JOIN LATERAL (
        SELECT "versionNumber", "effectiveFrom" FROM "Legal_Document_Versions"
        WHERE "documentId" = d."id" AND "effectiveFrom" <= now()
        ORDER BY "versionNumber" DESC LIMIT 1
      ) cur ON true
      LEFT JOIN "Legal_Drafts" dr ON dr."documentId" = d."id"
      WHERE d."isSandbox" = false`;
    const rank = (s: string) => {
      const i = (LEGAL_SLUGS as readonly string[]).indexOf(s);
      return i === -1 ? LEGAL_SLUGS.length : i;
    };
    return [...rows]
      .sort((a, b) => rank(a.slug) - rank(b.slug))
      .map((r) => ({
        slug: r.slug,
        title: r.title,
        kind: r.kind,
        currentVersion: r.currentVersion,
        effectiveFrom: r.effectiveFrom?.toISOString() ?? null,
        latestVersion: r.latestVersion,
        hasDraft: r.draftRevision !== null,
        draftRevision: r.draftRevision,
        draftUpdatedAt: r.draftUpdatedAt?.toISOString() ?? null,
        pendingPlaceholders:
          r.draftBody === null ? 0 : detectPlaceholders(r.draftBody).length,
      }));
  }

  async get(slug: string): Promise<LegalDraftResponseDto> {
    const doc = await findLegalDoc(this.prisma, slug);
    const [row] = await this.prisma.$queryRaw<DraftRow[]>`
      SELECT "bodyMd", "revision", "baseVersionNumber", "restoredFromVersion",
             "updatedAt", "updatedByEmail"
      FROM "Legal_Drafts" WHERE "documentId" = ${doc.id}::uuid`;
    if (!row) throw legalDraftNotFound();
    return toDto(doc.slug, row);
  }

  async put(
    slug: string,
    dto: PutDraftDto,
    actor: LegalActor,
  ): Promise<LegalDraftResponseDto> {
    const doc = await findLegalDoc(this.prisma, slug);
    // 400 LEGAL_MARKDOWN_INVALID / 503 LEGAL_MARKDOWN_BUSY, outside any lock.
    await this.markdown.validate(dto.bodyMd);
    const bytes = Buffer.byteLength(dto.bodyMd, 'utf8');

    const row = await legalTx(this.prisma, async (tx, budget) => {
      await lockLegalDoc(tx, budget, doc.id);
      let saved: DraftRow | undefined;
      if (dto.baseRevision === 0) {
        [saved] = await tx.$queryRaw<DraftRow[]>`
          INSERT INTO "Legal_Drafts"
            ("id", "documentId", "bodyMd", "revision", "baseVersionNumber", "updatedAt", "updatedById", "updatedByEmail")
          VALUES (gen_random_uuid(), ${doc.id}::uuid, ${dto.bodyMd}, DEFAULT,
            (SELECT max("versionNumber") FROM "Legal_Document_Versions" WHERE "documentId" = ${doc.id}::uuid),
            now(), ${actor.id}::uuid, ${actor.email})
          ON CONFLICT ("documentId") DO NOTHING
          RETURNING "bodyMd", "revision", "baseVersionNumber", "restoredFromVersion", "updatedAt", "updatedByEmail"`;
        if (!saved) {
          const [cur] = await tx.$queryRaw<{ revision: number }[]>`
            SELECT "revision" FROM "Legal_Drafts" WHERE "documentId" = ${doc.id}::uuid`;
          throw legalDraftStale(cur?.revision ?? null);
        }
        await this.audit.record(tx, {
          documentId: doc.id,
          action: 'DRAFT_CREATED',
          actor,
          meta: { revision: saved.revision, bytes },
        });
        return saved;
      }

      [saved] = await tx.$queryRaw<DraftRow[]>`
        UPDATE "Legal_Drafts"
        SET "bodyMd" = ${dto.bodyMd}, "revision" = "revision" + 1, "updatedAt" = now(),
            "updatedById" = ${actor.id}::uuid, "updatedByEmail" = ${actor.email}
        WHERE "documentId" = ${doc.id}::uuid AND "revision" = ${dto.baseRevision}
        RETURNING "bodyMd", "revision", "baseVersionNumber", "restoredFromVersion", "updatedAt", "updatedByEmail"`;
      if (!saved) {
        const [cur] = await tx.$queryRaw<{ revision: number }[]>`
          SELECT "revision" FROM "Legal_Drafts" WHERE "documentId" = ${doc.id}::uuid`;
        if (!cur) throw legalDraftNotFound();
        throw legalDraftStale(cur.revision);
      }
      // The UPDATE holds the draft row: concurrent edits serialize from here.
      await this.audit.recordDraftEdited(tx, {
        documentId: doc.id,
        actor,
        meta: { revision: saved.revision, bytes },
      });
      return saved;
    });
    return toDto(doc.slug, row);
  }

  async discard(slug: string, actor: LegalActor): Promise<void> {
    const doc = await findLegalDoc(this.prisma, slug);
    await legalTx(this.prisma, async (tx, budget) => {
      await lockLegalDoc(tx, budget, doc.id);
      const rows = await tx.$queryRaw<{ revision: number }[]>`
        DELETE FROM "Legal_Drafts" WHERE "documentId" = ${doc.id}::uuid
        RETURNING "revision"`;
      if (rows.length === 0) throw legalDraftNotFound();
      await this.audit.record(tx, {
        documentId: doc.id,
        action: 'DRAFT_DISCARDED',
        actor,
        meta: { revision: rows[0].revision },
      });
    });
  }

  async restore(
    slug: string,
    version: number,
    actor: LegalActor,
  ): Promise<LegalDraftResponseDto> {
    const doc = await findLegalDoc(this.prisma, slug);
    // Versions are immutable: reading outside the transaction is safe.
    const [src] = await this.prisma.$queryRaw<{ bodyMd: string }[]>`
      SELECT "bodyMd" FROM "Legal_Document_Versions"
      WHERE "documentId" = ${doc.id}::uuid AND "versionNumber" = ${version}`;
    if (!src) {
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        'LEGAL_VERSION_NOT_FOUND',
        'That version of the document does not exist.',
      );
    }
    const row = await legalTx(this.prisma, async (tx, budget) => {
      await lockLegalDoc(tx, budget, doc.id);
      const [saved] = await tx.$queryRaw<DraftRow[]>`
        INSERT INTO "Legal_Drafts"
          ("id", "documentId", "bodyMd", "revision", "baseVersionNumber", "restoredFromVersion",
           "updatedAt", "updatedById", "updatedByEmail")
        VALUES (gen_random_uuid(), ${doc.id}::uuid, ${src.bodyMd}, DEFAULT,
          (SELECT max("versionNumber") FROM "Legal_Document_Versions" WHERE "documentId" = ${doc.id}::uuid),
          ${version}, now(), ${actor.id}::uuid, ${actor.email})
        ON CONFLICT ("documentId") DO NOTHING
        RETURNING "bodyMd", "revision", "baseVersionNumber", "restoredFromVersion", "updatedAt", "updatedByEmail"`;
      if (!saved) {
        throw new ApiException(
          HttpStatus.CONFLICT,
          'LEGAL_DRAFT_EXISTS',
          'The document already has a draft; discard it before restoring a version.',
        );
      }
      await this.audit.record(tx, {
        documentId: doc.id,
        action: 'RESTORED',
        actor,
        versionNumber: version,
        meta: { restoredFromVersion: version },
      });
      return saved;
    });
    return toDto(doc.slug, row);
  }
}
