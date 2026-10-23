import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  TCG_API_CLIENT,
  type TcgApiClient,
} from '../tcg/tcg-api-client.interface.js';
import { SimulatorConfigService } from './simulator-config.service.js';
import { mapPackTier, type PackTier } from './pack-tiers.js';

export interface SimulatorSetSummary {
  gameSlug: string;
  setId: string;
  setName: string;
  cardCount: number;
  enabled: boolean;
  tierCoverage: Partial<Record<PackTier, number>>;
  unmappedRarities: { raw: string | null; count: number }[];
  hasReversePrintings: boolean;
}

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
  ) {}

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
        SELECT "gameSlug", "setId", rarity, count(*)::int AS n
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
