import { Injectable } from '@nestjs/common';
import { CatalogService } from '../catalog/catalog.service.js';
import type { ProductListItemDto } from '../catalog/dto/product-list-item.dto.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { VitrinaBlockMode, VitrinaMode } from './vitrina.types.js';

export type { VitrinaBlockMode } from './vitrina.types.js';

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
  /** Same DTO as the catalog list (what the Home renders). */
  product: ProductListItemDto;
}

export interface ResolveResult {
  runId: string | null;
  computedAt: Date | null;
  runMode: VitrinaMode | null;
  items: ResolvedItem[];
}

/**
 * Stories 18.8/18.9 (AD-85): resolves a Vitrina over the CURRENT run only
 * (`currentRunId`), so it never sees a half-written run, and never
 * recomputes. Queries per call: (1) run + scores in one JOIN, (2) products
 * via `CatalogService.findListItemsByIds` (called once; it batches products
 * and images). Availability (`isActive`, `stock - heldQty >= 1`) is evaluated
 * live per call; the ranking is not. Shared by the public Home, the draft
 * view and the admin preview, so all three resolve identically.
 */
@Injectable()
export class VitrinaSelectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
  ) {}

  async resolve(input: ResolveInput): Promise<ResolveResult> {
    const { run, scores } = await this.currentRunWithScores();
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

    const products = await this.catalog.findListItemsByIds(
      wanted.map((w) => w.id),
    );
    const live = new Map(
      products.filter((p) => p.inStock).map((p) => [p.id, p]),
    );

    const items: ResolvedItem[] = [];
    for (const w of wanted) {
      const product = live.get(w.id);
      if (product === undefined) continue; // sold out / inactive / unknown now
      if (items.length >= input.size) break;
      const s = byId.get(w.id);
      items.push({
        productId: w.id,
        name: product.name,
        source: w.source,
        rank: s?.rank ?? null,
        score: s?.score ?? null,
        reason: s?.reason ?? null,
        components: s?.components ?? null,
        product,
      });
    }
    return {
      runId: run?.id ?? null,
      computedAt: run?.computedAt ?? null,
      runMode: run?.mode ?? null,
      items,
    };
  }

  /** One query: settings -> current run -> its scores (rank order). */
  private async currentRunWithScores() {
    const rows = await this.prisma.$queryRaw<
      {
        runId: string;
        computedAt: Date;
        mode: VitrinaMode;
        productId: string | null;
        rank: number | null;
        score: unknown;
        components: unknown;
        reason: string | null;
      }[]
    >`
      SELECT r."id" AS "runId", r."computedAt", r."mode", s."productId",
             s."rank", s."score", s."components", s."reason"
      FROM "Vitrina_Algorithm_Settings" a
      JOIN "Product_Score_Runs" r ON r."id" = a."currentRunId"
      LEFT JOIN "Product_Scores" s ON s."runId" = r."id"
      WHERE a."id" = 'default'
      ORDER BY s."rank" ASC`;
    if (rows.length === 0) return { run: null, scores: [] };
    const first = rows[0];
    return {
      run: { id: first.runId, computedAt: first.computedAt, mode: first.mode },
      scores: rows
        .filter((r) => r.productId !== null)
        .map((r) => ({
          productId: r.productId as string,
          rank: r.rank as number,
          score: Number(r.score),
          components: r.components,
          reason: r.reason,
        })),
    };
  }
}
