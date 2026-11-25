import type { PrismaService } from './../../src/prisma/prisma.service.js';
import type { Prisma } from './../../src/generated/prisma/client.js';
import { PACK_TIERS, type PackTier } from './../../src/simulator/pack-tiers.js';
import { defaultPokemonTemplate } from './../../src/simulator/simulator-defaults.js';

/**
 * Story 22.8: e2e helpers that seed MANUAL simulator sets by Prisma (never through the 22.5
 * endpoints). Every set is created with a caller-owned name prefix so `cleanManualSets` only
 * ever deletes its own rows (cards cascade) and the dev DB is left untouched.
 */
export type TierCounts = Partial<Record<PackTier, number>>;

/** Smallest set that is `ready` for the default pokemon template (A111: 10 cards, every roll tier). */
export const MIN_TIERS: TierCounts = {
  COMMON: 4,
  UNCOMMON: 3,
  RARE: 3,
  DOUBLE_RARE: 1,
  ULTRA_RARE: 1,
  ILLUSTRATION_RARE: 1,
  SPECIAL_ILLUSTRATION_RARE: 1,
  HYPER_RARE: 1,
};

/** Generous set (120 cards) for the default template. */
export const BIG_TIERS: TierCounts = {
  COMMON: 40,
  UNCOMMON: 30,
  RARE: 20,
  DOUBLE_RARE: 10,
  ULTRA_RARE: 6,
  ILLUSTRATION_RARE: 6,
  SPECIAL_ILLUSTRATION_RARE: 5,
  HYPER_RARE: 3,
};

export interface SeedOptions {
  name: string;
  tiers: TierCounts;
  isActive?: boolean;
  template?: Prisma.InputJsonValue;
  imageUrl?: string | null;
}

export async function seedManualSet(
  prisma: PrismaService,
  o: SeedOptions,
): Promise<{ id: string; cardIds: string[] }> {
  const set = await prisma.simulatorSet.create({
    data: {
      name: o.name,
      nameKey: o.name.trim().replace(/\s+/g, ' ').toLowerCase(),
      imageUrl: o.imageUrl ?? null,
      template:
        o.template ??
        (defaultPokemonTemplate() as unknown as Prisma.InputJsonValue),
      isActive: o.isActive ?? true,
    },
  });
  const cards: Prisma.SimulatorCardCreateManyInput[] = [];
  let n = 0;
  for (const tier of PACK_TIERS)
    for (let i = 0; i < (o.tiers[tier] ?? 0); i++) {
      n++;
      cards.push({
        setId: set.id,
        name: `${o.name} card ${n}`,
        rarityTier: tier,
        number: String(n),
        imageUrl: `/uploads/public/simulator/${n}.png`,
        marketPriceUsd: n % 7 === 0 ? null : (n * 0.5).toFixed(2),
      });
    }
  await prisma.simulatorCard.createMany({ data: cards });
  const rows = await prisma.simulatorCard.findMany({
    where: { setId: set.id },
    select: { id: true },
  });
  return { id: set.id, cardIds: rows.map((r) => r.id) };
}

export const cleanManualSets = (prisma: PrismaService, prefix: string) =>
  prisma.simulatorSet.deleteMany({ where: { name: { startsWith: prefix } } });
