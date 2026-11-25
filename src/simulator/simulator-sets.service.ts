import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  TCG_API_CLIENT,
  type TcgApiClient,
} from '../tcg/tcg-api-client.interface.js';
import { SimulatorPoolCache } from './pool-cache.js';
import { SimulatorConfigService } from './simulator-config.service.js';
import { mapPackTier, PACK_TIERS, type PackTier } from './pack-tiers.js';
import { countCardsByTier } from './manual/assert-ready.js';
import { evaluateReadiness } from './manual/readiness.js';

/** A106: fixed while a single (Pokemon) template exists. */
export const MANUAL_GAME_SLUG = 'pokemon';

export interface SimulatorSetSummary {
  gameSlug: string;
  setId: string;
  setName: string;
  /** Unique cards (cardNumber ?? id): reverse printings are not counted twice. */
  cardCount: number;
  enabled: boolean;
  tierCoverage: Partial<Record<PackTier, number>>;
  unmappedRarities: { raw: string | null; count: number }[];
  hasReversePrintings: boolean;
}

export interface PublicSimulatorSet {
  setId: string;
  gameSlug: string;
  name: string;
  cardCount: number;
  imageUrl: string | null;
}

const PUBLIC_TTL_MS = 60_000;

interface RarityRow {
  gameSlug: string;
  setId: string;
  rarity: string | null;
  n: number;
}

@Injectable()
export class SimulatorSetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: SimulatorConfigService,
    @Inject(TCG_API_CLIENT) private readonly tcg: TcgApiClient,
    poolCache: SimulatorPoolCache,
  ) {
    poolCache.onClear(() => {
      this.publicCache = null;
      this.publicGen++;
    });
  }

  private publicCache: { at: number; data: PublicSimulatorSet[] } | null = null;
  /** Bumped on every clear so an in-flight list built before a write never repopulates the cache. */
  private publicGen = 0;

  /**
   * Public list (AD-108, story 22.8): ACTIVE manual sets that are also READY; in-memory cache 60 s,
   * dropped by `poolCache.clear()` on every write. Two queries: active sets + ONE aggregated count.
   */
  async listPublic(): Promise<PublicSimulatorSet[]> {
    const c = this.publicCache;
    if (c && Date.now() - c.at < PUBLIC_TTL_MS) return c.data;
    const gen = this.publicGen;
    const sets = await this.prisma.simulatorSet.findMany({
      where: { isActive: true },
      select: { id: true, name: true, imageUrl: true, template: true },
    });
    const counts = await countCardsByTier(
      this.prisma,
      sets.map((s) => s.id),
    );
    const data: PublicSimulatorSet[] = [];
    for (const s of sets) {
      const tiers = counts.get(s.id) ?? {};
      if (!evaluateReadiness(s.template, tiers).ready) continue;
      data.push({
        setId: s.id,
        gameSlug: MANUAL_GAME_SLUG,
        name: s.name,
        cardCount: PACK_TIERS.reduce((a, t) => a + (tiers[t] ?? 0), 0),
        imageUrl: s.imageUrl,
      });
    }
    data.sort((a, b) => a.name.localeCompare(b.name));
    if (gen === this.publicGen) this.publicCache = { at: Date.now(), data };
    return data;
  }

  /** Two aggregated queries (rarity groups + reverse flags), no per-set queries. */
  async list(): Promise<SimulatorSetSummary[]> {
    const cursors = await this.prisma.tcgIngestCursor.findMany({
      where: { status: 'DONE' },
      select: { gameSlug: true, setId: true, setName: true },
      orderBy: [{ gameSlug: 'asc' }, { setName: 'asc' }],
    });
    if (cursors.length === 0) return [];
    const provider = this.tcg.provider;
    const [rows, reverseRows, cfg] = await Promise.all([
      this.prisma.$queryRaw<RarityRow[]>(Prisma.sql`
        SELECT "gameSlug", "setId", rarity,
               count(DISTINCT COALESCE("cardNumber", id::text))::int AS n
        FROM "Master_Cards"
        WHERE "externalProvider" = ${provider}
          AND name !~* '^basic .* energy$'
        GROUP BY 1, 2, 3`),
      this.prisma.$queryRaw<{ gameSlug: string; setId: string }[]>(Prisma.sql`
        SELECT DISTINCT "gameSlug", "setId"
        FROM "Master_Cards"
        WHERE "externalProvider" = ${provider}
          AND printing ~* 'reverse'`),
      this.config.getEffective(),
    ]);
    const enabled = new Set(cfg.sets.map((s) => `${s.gameSlug}:${s.setId}`));
    const reverse = new Set(reverseRows.map((r) => `${r.gameSlug}:${r.setId}`));
    const bySet = new Map<string, RarityRow[]>();
    for (const r of rows) {
      const k = `${r.gameSlug}:${r.setId}`;
      const list = bySet.get(k);
      if (list) list.push(r);
      else bySet.set(k, [r]);
    }
    return cursors.map((c) => {
      const k = `${c.gameSlug}:${c.setId}`;
      const tierCoverage: Partial<Record<PackTier, number>> = {};
      const unmapped: { raw: string | null; count: number }[] = [];
      let cardCount = 0;
      for (const r of bySet.get(k) ?? []) {
        cardCount += r.n;
        const tier = mapPackTier(r.rarity);
        if (tier) tierCoverage[tier] = (tierCoverage[tier] ?? 0) + r.n;
        else unmapped.push({ raw: r.rarity, count: r.n });
      }
      unmapped.sort((a, b) => b.count - a.count);
      return {
        gameSlug: c.gameSlug,
        setId: c.setId,
        setName: c.setName,
        cardCount,
        enabled: enabled.has(k),
        tierCoverage,
        unmappedRarities: unmapped,
        hasReversePrintings: reverse.has(k),
      };
    });
  }
}
