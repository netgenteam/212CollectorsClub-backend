import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PrismaClient } from '../generated/prisma/client.js';
import { LegalAuditService } from './legal-audit.service.js';
import { LEGAL_SLUGS } from './legal-slugs.js';

/** Bound (ms) of the lock wait of every seed transaction (DB `lock_timeout`). */
const SEED_LOCK_TIMEOUT_MS = 10_000;

/** Template file of each real document (`prisma/seed-data/legal/<file>.md`). */
export const LEGAL_SEED_FILES: Record<(typeof LEGAL_SLUGS)[number], string> = {
  terminos: 'terminos.md',
  privacidad: 'privacidad.md',
  cookies: 'cookies.md',
  envios: 'envios.md',
  devoluciones: 'devoluciones.md',
  'aviso-legal': 'aviso-legal.md',
};

export interface LegalSeedTemplate {
  slug: string;
  bodyMd: string;
}

export type LegalSeedOutcome =
  | 'CREATED'
  | 'SKIPPED_HAS_VERSION'
  | 'SKIPPED_HAS_DRAFT'
  | 'SKIPPED_NO_DOCUMENT';

export interface LegalSeedResult {
  slug: string;
  outcome: LegalSeedOutcome;
}

/** Reads the six templates of a directory (default: `prisma/seed-data/legal`). */
export async function loadLegalSeedTemplates(
  dir: string = join(process.cwd(), 'prisma', 'seed-data', 'legal'),
): Promise<LegalSeedTemplate[]> {
  return Promise.all(
    LEGAL_SLUGS.map(async (slug) => ({
      slug,
      bodyMd: await readFile(join(dir, LEGAL_SEED_FILES[slug]), 'utf8'),
    })),
  );
}

/**
 * Story 19.3 (AD-88, AD-94, FR-110): idempotent seed of ONE draft per document.
 *
 * Never publishes. Per document, in one transaction: (1) lock the document row
 * (`FOR UPDATE`, same first step and order as every other legal write, so a
 * concurrent publish/edit/seed serializes instead of deadlocking); (2)
 * `INSERT … SELECT … WHERE NOT EXISTS (draft) AND NOT EXISTS (version)`
 * (never `upsert`); (3) only when a row was inserted, the `DRAFT_CREATED` audit
 * row (system action: no admin, `adminUserId`/`adminEmail` NULL). A skipped
 * document writes nothing, so repeated or parallel runs neither duplicate nor
 * overwrite an edited draft nor raise `draftRevisionFloor` (that only happens
 * when a draft is deleted). `revision` is omitted from the INSERT: the DB
 * trigger numbers it (`floor + 1`).
 */
export class LegalSeedService {
  private readonly audit = new LegalAuditService();

  constructor(private readonly db: Pick<PrismaClient, '$transaction'>) {}

  async seedDrafts(templates: LegalSeedTemplate[]): Promise<LegalSeedResult[]> {
    const results: LegalSeedResult[] = [];
    for (const t of templates) results.push(await this.seedOne(t));
    return results;
  }

  private seedOne(t: LegalSeedTemplate): Promise<LegalSeedResult> {
    const bytes = Buffer.byteLength(t.bodyMd, 'utf8');
    return this.db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          `SET LOCAL lock_timeout = ${SEED_LOCK_TIMEOUT_MS}`,
        );
        const [doc] = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "Legal_Documents" WHERE "slug" = ${t.slug} FOR UPDATE`;
        if (!doc) return { slug: t.slug, outcome: 'SKIPPED_NO_DOCUMENT' };

        const inserted = await tx.$queryRaw<{ revision: number }[]>`
          INSERT INTO "Legal_Drafts" ("id", "documentId", "bodyMd", "updatedAt")
          SELECT gen_random_uuid(), ${doc.id}::uuid, ${t.bodyMd}, now()
          WHERE NOT EXISTS (SELECT 1 FROM "Legal_Drafts" WHERE "documentId" = ${doc.id}::uuid)
            AND NOT EXISTS (SELECT 1 FROM "Legal_Document_Versions" WHERE "documentId" = ${doc.id}::uuid)
          RETURNING "revision"`;
        if (inserted.length > 0) {
          await this.audit.record(tx, {
            documentId: doc.id,
            action: 'DRAFT_CREATED',
            actor: null,
            meta: { source: 'seed', revision: inserted[0].revision, bytes },
          });
          return { slug: t.slug, outcome: 'CREATED' };
        }
        const [{ hasVersion }] = await tx.$queryRaw<{ hasVersion: boolean }[]>`
          SELECT EXISTS (SELECT 1 FROM "Legal_Document_Versions"
                          WHERE "documentId" = ${doc.id}::uuid) AS "hasVersion"`;
        return {
          slug: t.slug,
          outcome: hasVersion ? 'SKIPPED_HAS_VERSION' : 'SKIPPED_HAS_DRAFT',
        };
      },
      { timeout: SEED_LOCK_TIMEOUT_MS * 2 },
    );
  }
}
