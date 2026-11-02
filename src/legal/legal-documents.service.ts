import { HttpStatus, Injectable } from '@nestjs/common';
import { ApiException } from '../common/api-exception.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  LegalCurrentVersionsResponseDto,
  LegalDocumentResponseDto,
  LegalIdentityDto,
  LegalListItemDto,
  LegalVersionBodyDto,
  LegalVersionResponseDto,
  LegalVersionsResponseDto,
} from './dto/legal-public.dto.js';
import { LegalMarkdownService } from './legal-markdown.service.js';
import { LEGAL_SLUGS } from './legal-slugs.js';

interface DocRow {
  id: string;
  slug: string;
  title: string;
  kind: string;
  requiresAcceptance: boolean;
}
interface VersionRow {
  versionNumber: number;
  bodyMd: string;
  changeSummary: string;
  isSubstantial: boolean;
  effectiveFrom: Date;
  publishedAt: Date;
}

/**
 * Story 19.1 (AD-89 read side, AD-91 public). READ ONLY: no update/delete on
 * versions or audit rows exists here (a unit test greps the sources), and
 * the drafts table is never read. "Now" is the DATABASE clock (`now()`), so the
 * current version is the highest `versionNumber` with `effectiveFrom <= now()`.
 */
@Injectable()
export class LegalDocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly markdown: LegalMarkdownService,
  ) {}

  async list(): Promise<LegalListItemDto[]> {
    const rows = await this.prisma.$queryRaw<
      (DocRow & { versionNumber: number | null; effectiveFrom: Date | null })[]
    >`
      SELECT d."slug", d."title", d."kind"::text AS "kind", d."requiresAcceptance",
             v."versionNumber", v."effectiveFrom"
      FROM "Legal_Documents" d
      LEFT JOIN LATERAL (
        SELECT "versionNumber", "effectiveFrom"
        FROM "Legal_Document_Versions"
        WHERE "documentId" = d."id" AND "effectiveFrom" <= now()
        ORDER BY "versionNumber" DESC LIMIT 1
      ) v ON true
      WHERE d."isSandbox" = false`;
    return this.inFixedOrder(rows).map((r) => ({
      slug: r.slug,
      title: r.title,
      kind: r.kind,
      requiresAcceptance: r.requiresAcceptance,
      status: r.versionNumber === null ? 'IN_PREPARATION' : 'PUBLISHED',
      ...(r.versionNumber !== null && r.effectiveFrom
        ? {
            currentVersion: r.versionNumber,
            effectiveFrom: r.effectiveFrom.toISOString(),
          }
        : {}),
    }));
  }

  async currentVersions(): Promise<LegalCurrentVersionsResponseDto> {
    const rows = await this.prisma.$queryRaw<
      {
        slug: string;
        versionNumber: number;
        effectiveFrom: Date;
        lastSubstantialVersion: number | null;
      }[]
    >`
      SELECT d."slug", cur."versionNumber", cur."effectiveFrom",
             (SELECT max(s."versionNumber") FROM "Legal_Document_Versions" s
               WHERE s."documentId" = d."id" AND s."isSubstantial"
                 AND s."effectiveFrom" <= now()) AS "lastSubstantialVersion"
      FROM "Legal_Documents" d
      JOIN LATERAL (
        SELECT "versionNumber", "effectiveFrom"
        FROM "Legal_Document_Versions"
        WHERE "documentId" = d."id" AND "effectiveFrom" <= now()
        ORDER BY "versionNumber" DESC LIMIT 1
      ) cur ON true
      WHERE d."isSandbox" = false`;
    return {
      documents: this.inFixedOrder(rows).map((r) => ({
        slug: r.slug,
        versionNumber: r.versionNumber,
        effectiveFrom: r.effectiveFrom.toISOString(),
        lastSubstantialVersion: r.lastSubstantialVersion,
      })),
    };
  }

  async identity(): Promise<LegalIdentityDto> {
    const row = await this.prisma.sellerIdentitySetting.findUnique({
      where: { id: 'default' },
      select: {
        legalName: true,
        rif: true,
        fiscalAddress: true,
        contactEmail: true,
        phone: true,
      },
    });
    return {
      legalName: row?.legalName ?? null,
      rif: row?.rif ?? null,
      fiscalAddress: row?.fiscalAddress ?? null,
      contactEmail: row?.contactEmail ?? null,
      phone: row?.phone ?? null,
    };
  }

  async getDocument(slug: string): Promise<LegalDocumentResponseDto> {
    const doc = await this.findDoc(slug);
    const [cur] = await this.prisma.$queryRaw<VersionRow[]>`
      SELECT "versionNumber", "bodyMd", "changeSummary", "isSubstantial", "effectiveFrom", "publishedAt"
      FROM "Legal_Document_Versions"
      WHERE "documentId" = ${doc.id}::uuid AND "effectiveFrom" <= now()
      ORDER BY "versionNumber" DESC LIMIT 1`;
    const [next] = await this.prisma.$queryRaw<
      { versionNumber: number; effectiveFrom: Date }[]
    >`
      SELECT "versionNumber", "effectiveFrom"
      FROM "Legal_Document_Versions"
      WHERE "documentId" = ${doc.id}::uuid AND "effectiveFrom" > now()
      ORDER BY "versionNumber" ASC LIMIT 1`;
    return {
      slug: doc.slug,
      title: doc.title,
      status: cur ? 'PUBLISHED' : 'IN_PREPARATION',
      ...(cur ? { version: await this.toBody(cur) } : {}),
      ...(next
        ? {
            upcoming: {
              versionNumber: next.versionNumber,
              effectiveFrom: next.effectiveFrom.toISOString(),
            },
          }
        : {}),
    };
  }

  async listVersions(slug: string): Promise<LegalVersionsResponseDto> {
    const doc = await this.findDoc(slug);
    const rows = await this.prisma.$queryRaw<Omit<VersionRow, 'bodyMd'>[]>`
      SELECT "versionNumber", "changeSummary", "isSubstantial", "effectiveFrom", "publishedAt"
      FROM "Legal_Document_Versions"
      WHERE "documentId" = ${doc.id}::uuid AND "effectiveFrom" <= now()
      ORDER BY "versionNumber" DESC`;
    return {
      slug: doc.slug,
      title: doc.title,
      versions: rows.map((r, i) => ({
        versionNumber: r.versionNumber,
        changeSummary: r.changeSummary,
        isSubstantial: r.isSubstantial,
        effectiveFrom: r.effectiveFrom.toISOString(),
        publishedAt: r.publishedAt.toISOString(),
        isCurrent: i === 0,
      })),
    };
  }

  async getVersion(slug: string, n: number): Promise<LegalVersionResponseDto> {
    const doc = await this.findDoc(slug);
    const [row] = await this.prisma.$queryRaw<
      (VersionRow & {
        isCurrent: boolean;
        supersededAt: Date | null;
      })[]
    >`
      SELECT v."versionNumber", v."bodyMd", v."changeSummary", v."isSubstantial",
             v."effectiveFrom", v."publishedAt",
             (v."versionNumber" = (SELECT max(c."versionNumber") FROM "Legal_Document_Versions" c
                WHERE c."documentId" = v."documentId" AND c."effectiveFrom" <= now())) AS "isCurrent",
             (SELECT n."effectiveFrom" FROM "Legal_Document_Versions" n
                WHERE n."documentId" = v."documentId" AND n."versionNumber" > v."versionNumber"
                  AND n."effectiveFrom" <= now()
                ORDER BY n."versionNumber" ASC LIMIT 1) AS "supersededAt"
      FROM "Legal_Document_Versions" v
      WHERE v."documentId" = ${doc.id}::uuid AND v."versionNumber" = ${n}
        AND v."effectiveFrom" <= now()`;
    if (!row) {
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        'LEGAL_VERSION_NOT_FOUND',
        'That version of the document does not exist.',
      );
    }
    return {
      slug: doc.slug,
      title: doc.title,
      version: {
        ...(await this.toBody(row)),
        isCurrent: row.isCurrent,
        supersededAt: row.supersededAt?.toISOString() ?? null,
      },
    };
  }

  /** The toc comes from the worker-backed, content-addressed cache (never parsed here). */
  private async toBody(r: VersionRow): Promise<LegalVersionBodyDto> {
    return {
      versionNumber: r.versionNumber,
      bodyMd: r.bodyMd,
      toc: await this.markdown.buildToc(r.bodyMd),
      changeSummary: r.changeSummary,
      isSubstantial: r.isSubstantial,
      effectiveFrom: r.effectiveFrom.toISOString(),
      publishedAt: r.publishedAt.toISOString(),
    };
  }

  private async findDoc(slug: string): Promise<DocRow> {
    const [doc] = await this.prisma.$queryRaw<DocRow[]>`
      SELECT "id", "slug", "title", "kind"::text AS "kind", "requiresAcceptance"
      FROM "Legal_Documents" WHERE "slug" = ${slug}`;
    if (!doc) {
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        'LEGAL_DOCUMENT_NOT_FOUND',
        'Legal document not found.',
      );
    }
    return doc;
  }

  private inFixedOrder<T extends { slug: string }>(rows: T[]): T[] {
    const rank = (s: string) => {
      const i = (LEGAL_SLUGS as readonly string[]).indexOf(s);
      return i === -1 ? LEGAL_SLUGS.length : i;
    };
    return [...rows].sort((a, b) => rank(a.slug) - rank(b.slug));
  }
}
