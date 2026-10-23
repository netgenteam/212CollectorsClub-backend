import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  TCG_API_CLIENT,
  type TcgApiClient,
} from '../tcg/tcg-api-client.interface.js';
import { SimulatorPoolCache } from './pool-cache.js';
import { SimulatorConfigService } from './simulator-config.service.js';
import { mapPackTier, type PackTier } from './pack-tiers.js';

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
    });
  }

  private publicCache: { at: number; data: PublicSimulatorSet[] } | null = null;

  /** Public list (AD-66): enabled AND cursor DONE; in-memory cache 60 s. */
  async listPublic(): Promise<PublicSimulatorSet[]> {
    const c = this.publicCache;
    if (c && Date.now() - c.at < PUBLIC_TTL_MS) return c.data;
    const cfg = await this.config.getEffective();
    let data: PublicSimulatorSet[] = [];
    if (cfg.sets.length > 0) {
      const cursors = await this.prisma.tcgIngestCursor.findMany({
        where: {
          status: 'DONE',
          OR: cfg.sets.map((s) => ({ gameSlug: s.gameSlug, setId: s.setId })),
        },
        select: { gameSlug: true, setId: true, setName: true },
      });
      if (cursors.length > 0) {
        // One query: unique card count (same key as the draw: cardNumber ?? id,
        // so reverse printings do not inflate it) + image of the top-priced card.
        const rows = await this.prisma.$queryRaw<
          {
            gameSlug: string;
            setId: string;
            imageLarge: string | null;
            imageSmall: string | null;
            n: number;
          }[]
        >(Prisma.sql`
          SELECT DISTINCT ON ("gameSlug", "setId") "gameSlug", "setId",
                 "imageLarge", "imageSmall",
                 (SELECT count(DISTINCT COALESCE(m2."cardNumber", m2.id::text))
                    FROM "Master_Cards" m2
                   WHERE m2."externalProvider" = ${this.tcg.provider}
                     AND m2.name !~* '^basic .* energy$'
                     AND m2."gameSlug" = "Master_Cards"."gameSlug"
                     AND m2."setId" = "Master_Cards"."setId")::int AS n
          FROM "Master_Cards"
          WHERE "externalProvider" = ${this.tcg.provider}
            AND name !~* '^basic .* energy$'
            AND ("gameSlug", "setId") IN (${Prisma.join(
              cursors.map((k) => Prisma.sql`(${k.gameSlug}, ${k.setId})`),
            )})
          ORDER BY "gameSlug", "setId", "marketPriceUsd" DESC NULLS LAST, id`);
        const info = new Map(rows.map((r) => [`${r.gameSlug}:${r.setId}`, r]));
        data = cursors
          .map((k) => {
            const conf = cfg.sets.find(
              (s) => s.gameSlug === k.gameSlug && s.setId === k.setId,
            );
            const r = info.get(`${k.gameSlug}:${k.setId}`);
            return {
              setId: k.setId,
              gameSlug: k.gameSlug,
              name: conf?.displayName ?? k.setName,
              cardCount: r?.n ?? 0,
              imageUrl:
                conf?.imageUrl ?? r?.imageLarge ?? r?.imageSmall ?? null,
            };
          })
          .filter((s) => s.cardCount > 0)
          .sort((a, b) => a.name.localeCompare(b.name));
      }
    }
    this.publicCache = { at: Date.now(), data };
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
