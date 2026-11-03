import { HttpStatus, Injectable } from '@nestjs/common';
import { ApiException } from '../common/api-exception.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { PublishDto, PublishedVersionDto } from './dto/legal-admin.dto.js';
import {
  findLegalDoc,
  legalDraftNotFound,
  legalDraftStale,
  legalTx,
  type LegalActor,
} from './legal-admin.common.js';
import { LegalAuditService } from './legal-audit.service.js';
import {
  LegalMarkdownService,
  type LegalResidual,
} from './legal-markdown.service.js';
import {
  detectPlaceholders,
  findTemplateNotice,
  LEGAL_TEMPLATE_NOTICE,
} from './legal-placeholders.js';

/** An effectiveFrom further than this ahead would freeze the monotonic rule for ever (versions are immutable). */
export const MAX_EFFECTIVE_AHEAD_DAYS = 366;
const MAX_PLACEHOLDER_ITEMS = 200;

interface DraftLock {
  bodyMd: string;
  revision: number;
  restoredFromVersion: number | null;
}

const effectiveInvalid = (message: string, details: Record<string, unknown>) =>
  new ApiException(
    HttpStatus.BAD_REQUEST,
    'LEGAL_EFFECTIVE_FROM_INVALID',
    message,
    details,
  );

/**
 * Story 19.2 (AD-89, FR-105/106): publishes the draft as a new IMMUTABLE
 * version. One `$transaction`: lock the document row, check the draft is
 * exactly what the admin saw, number, insert, delete the draft, audit.
 *
 * The (slow, up to 3 s) Markdown validation runs BEFORE the transaction and
 * never while `FOR UPDATE` is held; inside, the draft is re-read under its row
 * lock and must be byte-identical to what was validated (otherwise 409), so
 * nothing unvalidated can be published. Placeholders are a pure, cheap check
 * and run again inside.
 */
@Injectable()
export class LegalPublishService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly markdown: LegalMarkdownService,
    private readonly audit: LegalAuditService,
  ) {}

  async publish(
    slug: string,
    dto: PublishDto,
    actor: LegalActor,
  ): Promise<PublishedVersionDto> {
    const doc = await findLegalDoc(this.prisma, slug);
    const effectiveInstant = new Date(dto.effectiveFrom);
    if (Number.isNaN(effectiveInstant.getTime())) {
      throw effectiveInvalid('effectiveFrom is not a valid date.', {});
    }
    const effectiveIso = effectiveInstant.toISOString();

    // Pre-flight (no lock): stale check + Markdown validation of the draft seen.
    const [seen] = await this.prisma.$queryRaw<DraftLock[]>`
      SELECT "bodyMd", "revision", "restoredFromVersion" FROM "Legal_Drafts"
      WHERE "documentId" = ${doc.id}::uuid`;
    if (!seen) throw legalDraftNotFound();
    if (seen.revision !== dto.expectedRevision) {
      throw legalDraftStale(seen.revision);
    }
    // 400 / 503, outside any lock. `residuals` (Story 19.3a) are computed on
    // the AST text in the worker; the locked draft below is byte-identical.
    const { residuals } = await this.markdown.validate(seen.bodyMd);
    this.assertNoPlaceholders(seen.bodyMd, residuals);

    return legalTx(this.prisma, async (tx, budget) => {
      // (1) serializes publishers of the same document.
      await tx.$queryRaw`SELECT "id" FROM "Legal_Documents" WHERE "id" = ${doc.id}::uuid FOR UPDATE`;
      // (2) the draft, under its own lock (edit/discard/restore take the
      // document first, like this, so they are already queued behind (1)).
      const [draft] = await tx.$queryRaw<DraftLock[]>`
        SELECT "bodyMd", "revision", "restoredFromVersion" FROM "Legal_Drafts"
        WHERE "documentId" = ${doc.id}::uuid FOR UPDATE`;
      await budget.release();
      if (!draft) throw legalDraftNotFound();
      if (draft.revision !== dto.expectedRevision) {
        throw legalDraftStale(draft.revision);
      }
      // Same revision but different text = discarded and recreated since the
      // validation: it was not validated, treat it as stale.
      if (draft.bodyMd !== seen.bodyMd) throw legalDraftStale(draft.revision);
      // (3) placeholders again, on the locked draft.
      this.assertNoPlaceholders(draft.bodyMd, residuals);

      // effectiveFrom against the DATABASE clock (A81, monotonic).
      const [chk] = await tx.$queryRaw<
        { minFrom: Date; maxFrom: Date; tooEarly: boolean; tooFar: boolean }[]
      >`
        WITH b AS (
          SELECT greatest(now(), coalesce(
            (SELECT "effectiveFrom" FROM "Legal_Document_Versions"
              WHERE "documentId" = ${doc.id}::uuid ORDER BY "versionNumber" DESC LIMIT 1), now())) AS "minFrom"
        )
        SELECT b."minFrom", now() + make_interval(days => ${MAX_EFFECTIVE_AHEAD_DAYS}::int) AS "maxFrom",
               (${effectiveIso}::timestamptz < b."minFrom") AS "tooEarly",
               (${effectiveIso}::timestamptz > now() + make_interval(days => ${MAX_EFFECTIVE_AHEAD_DAYS}::int)) AS "tooFar"
        FROM b`;
      if (chk.tooEarly) {
        throw effectiveInvalid(
          'effectiveFrom cannot be before now nor before the effective date of the latest version.',
          { minEffectiveFrom: chk.minFrom.toISOString() },
        );
      }
      if (chk.tooFar) {
        throw effectiveInvalid(
          `effectiveFrom cannot be more than ${MAX_EFFECTIVE_AHEAD_DAYS} days ahead.`,
          { maxEffectiveFrom: chk.maxFrom.toISOString() },
        );
      }

      // (4) numbering + INSERT. The unique key and the DB guard trigger are
      // the safety net (a rejection becomes a retryable 409 in `legalTx`).
      const [version] = await tx.$queryRaw<
        { versionNumber: number; effectiveFrom: Date; publishedAt: Date }[]
      >`
        INSERT INTO "Legal_Document_Versions"
          ("id", "documentId", "versionNumber", "bodyMd", "changeSummary", "isSubstantial",
           "effectiveFrom", "publishedById", "publishedByEmail", "restoredFromVersion")
        SELECT gen_random_uuid(), ${doc.id}::uuid,
               coalesce(max("versionNumber"), 0) + 1, ${draft.bodyMd}, ${dto.changeSummary},
               ${dto.isSubstantial}, ${effectiveIso}::timestamptz, ${actor.id}::uuid, ${actor.email},
               ${draft.restoredFromVersion}::int
        FROM "Legal_Document_Versions" WHERE "documentId" = ${doc.id}::uuid
        RETURNING "versionNumber", "effectiveFrom", "publishedAt"`;

      // (5) the draft goes away; (6) audit, same transaction.
      await tx.$executeRaw`DELETE FROM "Legal_Drafts" WHERE "documentId" = ${doc.id}::uuid`;
      await this.audit.record(tx, {
        documentId: doc.id,
        action: 'PUBLISHED',
        actor,
        versionNumber: version.versionNumber,
        meta: {
          isSubstantial: dto.isSubstantial,
          effectiveFrom: version.effectiveFrom.toISOString(),
          draftRevision: draft.revision,
          restoredFromVersion: draft.restoredFromVersion,
          changeSummary: dto.changeSummary.slice(0, 200),
        },
      });
      return {
        slug: doc.slug,
        versionNumber: version.versionNumber,
        effectiveFrom: version.effectiveFrom.toISOString(),
        publishedAt: version.publishedAt.toISOString(),
        changeSummary: dto.changeSummary,
        isSubstantial: dto.isSubstantial,
        restoredFromVersion: draft.restoredFromVersion,
      };
    });
  }

  private assertNoPlaceholders(
    bodyMd: string,
    residuals: LegalResidual[] = [],
  ): void {
    const items = detectPlaceholders(bodyMd);
    // The seeded "Plantilla — revisar…" notice is a blocker on its own: it
    // reuses this 422 (same shape) so removing only its token is not enough.
    const noticeLine = findTemplateNotice(bodyMd);
    if (noticeLine !== null) {
      items.push({ token: LEGAL_TEMPLATE_NOTICE, line: noticeLine });
    }
    // Story 19.3a: whatever is left of a marker or of the notice in the text
    // the public will read (normalized AST text), however it was disguised.
    // Same 422 and shape; an item already reported on the raw text is not
    // repeated (same token and line; the notice is reported once).
    for (const r of residuals) {
      const dup = items.some((i) =>
        r.token === LEGAL_TEMPLATE_NOTICE
          ? i.token === r.token
          : i.token === r.token && i.line === r.line,
      );
      if (!dup) items.push(r);
    }
    if (items.length === 0) return;
    throw new ApiException(
      HttpStatus.UNPROCESSABLE_ENTITY,
      'LEGAL_PLACEHOLDERS_PENDING',
      'The draft still has unresolved [[PLACEHOLDERS]]; replace them before publishing.',
      {
        items: items.slice(0, MAX_PLACEHOLDER_ITEMS),
        total: items.length,
      },
    );
  }
}
