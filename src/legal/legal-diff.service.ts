import { HttpStatus, Injectable } from '@nestjs/common';
import { ApiException } from '../common/api-exception.js';
import { PoolFailure } from './legal-markdown-pool.js';
import { LegalMarkdownService } from './legal-markdown.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  DiffResponseDto,
  HistoryResponseDto,
} from './dto/legal-admin.dto.js';
import { findLegalDoc } from './legal-admin.common.js';

/** Story 19.2 (AD-91, FR-107): history and diff. READ ONLY. */
@Injectable()
export class LegalDiffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly markdown: LegalMarkdownService,
  ) {}

  async history(slug: string): Promise<HistoryResponseDto> {
    const doc = await findLegalDoc(this.prisma, slug);
    const rows = await this.prisma.$queryRaw<
      {
        versionNumber: number;
        publishedByEmail: string | null;
        publishedAt: Date;
        effectiveFrom: Date;
        changeSummary: string;
        isSubstantial: boolean;
        restoredFromVersion: number | null;
        inForce: boolean;
      }[]
    >`
      SELECT "versionNumber", "publishedByEmail", "publishedAt", "effectiveFrom", "changeSummary",
             "isSubstantial", "restoredFromVersion", ("effectiveFrom" <= now()) AS "inForce"
      FROM "Legal_Document_Versions" WHERE "documentId" = ${doc.id}::uuid
      ORDER BY "versionNumber" DESC`;
    const currentNumber = rows.find((r) => r.inForce)?.versionNumber ?? null;
    return {
      slug: doc.slug,
      title: doc.title,
      versions: rows.map((r) => ({
        versionNumber: r.versionNumber,
        publishedByEmail: r.publishedByEmail,
        publishedAt: r.publishedAt.toISOString(),
        effectiveFrom: r.effectiveFrom.toISOString(),
        changeSummary: r.changeSummary,
        isSubstantial: r.isSubstantial,
        restoredFromVersion: r.restoredFromVersion,
        isCurrent: r.versionNumber === currentNumber,
        isScheduled: !r.inForce,
      })),
    };
  }

  async diff(slug: string, from: number, to: number): Promise<DiffResponseDto> {
    const doc = await findLegalDoc(this.prisma, slug);
    const rows = await this.prisma.$queryRaw<
      { versionNumber: number; bodyMd: string }[]
    >`
      SELECT "versionNumber", "bodyMd" FROM "Legal_Document_Versions"
      WHERE "documentId" = ${doc.id}::uuid AND "versionNumber" IN (${from}, ${to})`;
    const body = (n: number) => rows.find((r) => r.versionNumber === n)?.bodyMd;
    const a = body(from);
    const b = body(to);
    if (a === undefined || b === undefined) {
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        'LEGAL_VERSION_NOT_FOUND',
        'One of the versions does not exist.',
        { missing: [from, to].filter((n) => body(n) === undefined) },
      );
    }
    // Off the event loop (shared worker pool, hard deadline). Never a 500.
    try {
      return { from, to, ...(await this.markdown.diff(a, b)) };
    } catch (e) {
      if (e instanceof PoolFailure && e.kind === 'TIMEOUT') {
        throw new ApiException(
          HttpStatus.UNPROCESSABLE_ENTITY,
          'LEGAL_DIFF_TOO_LARGE',
          'The two versions differ too much to be compared in the allowed time.',
        );
      }
      if (e instanceof PoolFailure && e.kind === 'FAILED') {
        throw new ApiException(
          HttpStatus.UNPROCESSABLE_ENTITY,
          'LEGAL_DIFF_TOO_LARGE',
          'The two versions could not be compared (too large or too different).',
        );
      }
      throw new ApiException(
        HttpStatus.SERVICE_UNAVAILABLE,
        'LEGAL_MARKDOWN_BUSY',
        'The comparison service is busy; retry in a few seconds.',
      );
    }
  }
}
