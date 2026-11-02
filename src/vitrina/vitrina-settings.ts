import { Prisma } from '../generated/prisma/client.js';
import type { ScoringConfig } from './vitrina.types.js';

/** Singleton id of `Vitrina_Algorithm_Settings` (seeded by the 18.6 migration). */
export const VITRINA_SETTING_ID = 'default';

/** Row of `Vitrina_Algorithm_Settings` as read with raw SQL (Decimals kept). */
export interface SettingRow {
  wSales: number;
  wRevenue: number;
  wVelocity: number;
  wInterest: number;
  wNovelty: number;
  halfLifeDays: number;
  windowDays: number;
  noveltyDays: number;
  maxPerFranchise: number;
  mmrLambda: Prisma.Decimal;
  priorM: Prisma.Decimal;
  scarcityThreshold: number;
  minSalesForRanking: number;
  viewDayCap: number;
  currentRunId: string | null;
  updatedAt: Date;
  updatedById: string | null;
}

/**
 * Locks the singleton (`FOR UPDATE`) and returns it; creates the default row
 * first (`ON CONFLICT DO NOTHING`, never `upsert`) if a restore removed it.
 */
export async function lockSetting(
  tx: Prisma.TransactionClient,
  forUpdate = true,
): Promise<SettingRow> {
  await tx.$executeRaw`
    INSERT INTO "Vitrina_Algorithm_Settings" ("id", "updatedAt")
    VALUES (${VITRINA_SETTING_ID}, now())
    ON CONFLICT ("id") DO NOTHING`;
  const rows = await tx.$queryRaw<SettingRow[]>`
    SELECT "wSales", "wRevenue", "wVelocity", "wInterest", "wNovelty",
           "halfLifeDays", "windowDays", "noveltyDays", "maxPerFranchise",
           "mmrLambda", "priorM", "scarcityThreshold", "minSalesForRanking",
           "viewDayCap", "currentRunId", "updatedAt", "updatedById"
    FROM "Vitrina_Algorithm_Settings"
    WHERE "id" = ${VITRINA_SETTING_ID}
    ${forUpdate ? Prisma.sql`FOR UPDATE` : Prisma.empty}`;
  return rows[0];
}

/** The tunable part of the settings (what is audited and copied into a run). */
export function toScoringConfig(r: SettingRow): ScoringConfig {
  return {
    wSales: r.wSales,
    wRevenue: r.wRevenue,
    wVelocity: r.wVelocity,
    wInterest: r.wInterest,
    wNovelty: r.wNovelty,
    halfLifeDays: r.halfLifeDays,
    windowDays: r.windowDays,
    noveltyDays: r.noveltyDays,
    maxPerFranchise: r.maxPerFranchise,
    mmrLambda: Number(r.mmrLambda),
    priorM: Number(r.priorM),
    scarcityThreshold: r.scarcityThreshold,
    minSalesForRanking: r.minSalesForRanking,
    viewDayCap: r.viewDayCap,
  };
}
