import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type { VitrinaMode } from './vitrina.types.js';

export type VitrinaBlockMode = 'MANUAL' | 'AUTO' | 'MIXED';

export interface ResolveInput {
  mode: VitrinaBlockMode;
  /** Total slots (4..12). */
  size: number;
  /** Pinned product ids, in display order (kept first in MANUAL/MIXED). */
  pinned: string[];
}

export interface ResolvedItem {
  productId: string;
  name: string;
  source: 'pinned' | 'auto';
  /** Position in the current run (after MMR); `null` if the product is not in it. */
  rank: number | null;
  score: number | null;
  reason: string | null;
  components: unknown;
}

export interface ResolveResult {
  runId: string | null;
  computedAt: Date | null;
  runMode: VitrinaMode | null;
  items: ResolvedItem[];
}

/**
 * Story 18.8 (AD-85, read half): resolves a Vitrina over the CURRENT run only
 * (`currentRunId`), so it never sees a half-written run. Story 18.9 extends it
 * for `LandingContentService.expandVitrina`. Cost: 3 simple queries
 * (run+scores, live availability). Availability is evaluated live per call;
 * the ranking is not.
 */
@Injectable()
export class VitrinaSelectionService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(input: ResolveInput): Promise<ResolveResult> {
    const run = await this.currentRun();
    const scores = run
      ? await this.prisma.productScore.findMany({
          where: { runId: run.id },
          orderBy: { rank: 'asc' },
        })
      : [];
    const byId = new Map(scores.map((s) => [s.productId, s]));

    const seen = new Set<string>();
    const wanted: { id: string; source: 'pinned' | 'auto' }[] = [];
    const push = (id: string, source: 'pinned' | 'auto'): void => {
      if (!seen.has(id)) {
        seen.add(id);
        wanted.push({ id, source });
      }
    };
    if (input.mode !== 'AUTO')
      for (const id of input.pinned) push(id, 'pinned');
    if (input.mode !== 'MANUAL')
      for (const s of scores) push(s.productId, 'auto');

    const live = wanted.length
      ? await this.prisma.$queryRaw<{ id: string; name: string }[]>`
          SELECT "id", "name" FROM "Products"
          WHERE "id" = ANY(${wanted.map((w) => w.id)}::uuid[])
            AND "isActive" AND ("stock" - "heldQty") >= 1`
      : [];
    const names = new Map(live.map((p) => [p.id, p.name]));

    const items: ResolvedItem[] = [];
    for (const w of wanted) {
      const name = names.get(w.id);
      if (name === undefined) continue; // sold out / inactive / unknown now
      if (items.length >= input.size) break;
      const s = byId.get(w.id);
      items.push({
        productId: w.id,
        name,
        source: w.source,
        rank: s?.rank ?? null,
        score: s ? s.score.toNumber() : null,
        reason: s?.reason ?? null,
        components: s?.components ?? null,
      });
    }
    return {
      runId: run?.id ?? null,
      computedAt: run?.computedAt ?? null,
      runMode: run?.mode ?? null,
      items,
    };
  }

  private async currentRun() {
    const rows = await this.prisma.$queryRaw<{ currentRunId: string | null }[]>`
      SELECT "currentRunId" FROM "Vitrina_Algorithm_Settings" WHERE "id" = 'default'`;
    const id = rows[0]?.currentRunId;
    if (!id) return null;
    return this.prisma.productScoreRun.findUnique({ where: { id } });
  }
}
