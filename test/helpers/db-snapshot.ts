import { Prisma } from './../../src/generated/prisma/client.js';
import type { PrismaService } from './../../src/prisma/prisma.service.js';

/**
 * Faithful snapshot/restore of rows an e2e suite has to wipe, so running the
 * suite against a DB with real content never destroys it. Nullable Json
 * columns come back from `findMany` as JS `null` for BOTH SQL NULL and JSON
 * `null`; writing that `null` back would store JSON null, so it is mapped to
 * `Prisma.DbNull` (rows never legitimately hold a JSON null in these columns).
 */
const dbJson = (v: Prisma.JsonValue | null) =>
  v === null ? Prisma.DbNull : (v as Prisma.InputJsonValue);

export type LandingRows = Prisma.LandingConfigEntryGetPayload<object>[];

export const snapshotLanding = (
  prisma: PrismaService,
  where: Prisma.LandingConfigEntryWhereInput,
): Promise<LandingRows> => prisma.landingConfigEntry.findMany({ where });

/** Deletes the rows matching `where` and re-creates the snapshot field by field. */
export async function restoreLanding(
  prisma: PrismaService,
  where: Prisma.LandingConfigEntryWhereInput,
  rows: LandingRows,
): Promise<void> {
  await prisma.landingConfigEntry.deleteMany({ where });
  if (rows.length === 0) return;
  // updatedById/draftUpdatedById reference admins: drop a dangling reference.
  const adminIds = new Set(
    (
      await prisma.adminUser.findMany({
        where: {
          id: {
            in: rows
              .flatMap((r) => [r.updatedById, r.draftUpdatedById])
              .filter((x): x is string => !!x),
          },
        },
        select: { id: true },
      })
    ).map((a) => a.id),
  );
  await prisma.landingConfigEntry.createMany({
    data: rows.map((r) => ({
      ...r,
      value: r.value as Prisma.InputJsonValue,
      draftValue: dbJson(r.draftValue),
      updatedById:
        r.updatedById && adminIds.has(r.updatedById) ? r.updatedById : null,
      draftUpdatedById:
        r.draftUpdatedById && adminIds.has(r.draftUpdatedById)
          ? r.draftUpdatedById
          : null,
    })),
  });
}

export type SyncRuns = Prisma.TcgSyncRunGetPayload<object>[];

export const snapshotSyncRuns = (prisma: PrismaService): Promise<SyncRuns> =>
  prisma.tcgSyncRun.findMany();

export async function restoreSyncRuns(
  prisma: PrismaService,
  rows: SyncRuns,
): Promise<void> {
  await prisma.tcgSyncRun.deleteMany();
  if (rows.length === 0) return;
  await prisma.tcgSyncRun.createMany({
    data: rows.map((r) => ({
      ...r,
      bigVariations: dbJson(r.bigVariations),
      summary: dbJson(r.summary),
    })),
  });
}

/**
 * The nightly worker syncs EVERY `DONE` cursor. Parks the ones not belonging
 * to `ownGame` as PENDING and returns a function restoring each one's
 * ORIGINAL status.
 */
export async function parkForeignDoneCursors(
  prisma: PrismaService,
  ownGame: string,
): Promise<() => Promise<void>> {
  const parked = await prisma.tcgIngestCursor.findMany({
    where: { status: 'DONE', gameSlug: { not: ownGame } },
    select: { id: true, status: true, updatedAt: true },
  });
  await prisma.tcgIngestCursor.updateMany({
    where: { id: { in: parked.map((c) => c.id) } },
    data: { status: 'PENDING' },
  });
  return async () => {
    for (const c of parked)
      await prisma.tcgIngestCursor.updateMany({
        where: { id: c.id },
        data: { status: c.status, updatedAt: c.updatedAt },
      });
  };
}

/**
 * Ingestion only discovers a game's sets when it has NO cursors, so a suite
 * that exercises discovery for a real game slug must not see foreign ones.
 * Removes the cursors matching `where` and returns a function that
 * re-creates them verbatim (status, nextPage, updatedAt, ...).
 */
export async function stashCursors(
  prisma: PrismaService,
  where: Prisma.TcgIngestCursorWhereInput,
): Promise<() => Promise<void>> {
  const rows = await prisma.tcgIngestCursor.findMany({ where });
  await prisma.tcgIngestCursor.deleteMany({
    where: { id: { in: rows.map((r) => r.id) } },
  });
  return async () => {
    if (rows.length) await prisma.tcgIngestCursor.createMany({ data: rows });
  };
}

export type FxState = {
  setting: Prisma.FxRateSettingGetPayload<object> | null;
  snapshots: Prisma.FxRateSnapshotGetPayload<object>[];
  /**
   * Story 18.12: `to_jsonb` text of the rate row and of every snapshot. JS
   * `Date` only keeps milliseconds, but Postgres timestamps keep microseconds
   * (`now()`); restoring from these texts is byte faithful.
   */
  rawSetting?: string | null;
  rawSnapshots?: string;
};

/** Story 18.1: snapshot of the real FX rate row and its snapshot history. */
export async function snapshotFx(prisma: PrismaService): Promise<FxState> {
  return {
    setting: await prisma.fxRateSetting.findUnique({
      where: { id: 'default' },
    }),
    snapshots: await prisma.fxRateSnapshot.findMany(),
    rawSetting: (
      await prisma.$queryRaw<{ j: string | null }[]>`
        SELECT to_jsonb(t)::text AS j FROM "Fx_Rate_Settings" t WHERE t."id" = 'default'`
    )[0]?.j,
    rawSnapshots: (
      await prisma.$queryRaw<{ j: string }[]>`
        SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t."id"), '[]'::jsonb)::text AS j
        FROM "Fx_Rate_Snapshots" t`
    )[0].j,
  };
}

/**
 * Restores the FX row byte for byte (raw UPDATE so `@updatedAt` is not bumped)
 * and re-creates the snapshots verbatim.
 */
export async function restoreFx(
  prisma: PrismaService,
  s: FxState,
): Promise<void> {
  await prisma.fxRateSnapshot.deleteMany();
  if (s.rawSnapshots !== undefined) {
    await prisma.$executeRaw`
      INSERT INTO "Fx_Rate_Snapshots"
      SELECT * FROM jsonb_populate_recordset(null::"Fx_Rate_Snapshots", ${s.rawSnapshots}::jsonb)`;
  } else if (s.snapshots.length) {
    await prisma.fxRateSnapshot.createMany({ data: s.snapshots });
  }
  const r = s.setting;
  if (!r) {
    await prisma.fxRateSetting.deleteMany({ where: { id: 'default' } });
    return;
  }
  if (s.rawSetting) {
    // Every column, microseconds included (raw UPDATE: `updatedAt` is ours).
    await prisma.$executeRaw`
      UPDATE "Fx_Rate_Settings" t SET
        "vesPerUsd" = r."vesPerUsd", "updatedAt" = r."updatedAt", "source" = r."source",
        "manualVesPerUsd" = r."manualVesPerUsd", "maxAgeHours" = r."maxAgeHours",
        "maxVariationPct" = r."maxVariationPct", "rateFetchedAt" = r."rateFetchedAt",
        "providerUpdatedAt" = r."providerUpdatedAt", "lastError" = r."lastError",
        "lastErrorAt" = r."lastErrorAt", "rejectedReading" = r."rejectedReading"
      FROM jsonb_populate_record(null::"Fx_Rate_Settings", ${s.rawSetting}::jsonb) r
      WHERE t."id" = r."id"`;
    return;
  }
  const rejected =
    r.rejectedReading === null ? null : JSON.stringify(r.rejectedReading);
  await prisma.$executeRaw`
    UPDATE "Fx_Rate_Settings" SET
      "vesPerUsd" = ${r.vesPerUsd},
      "updatedAt" = ${r.updatedAt},
      "source" = ${r.source}::"FxRateSource",
      "manualVesPerUsd" = ${r.manualVesPerUsd},
      "maxAgeHours" = ${r.maxAgeHours},
      "maxVariationPct" = ${r.maxVariationPct},
      "rateFetchedAt" = ${r.rateFetchedAt},
      "providerUpdatedAt" = ${r.providerUpdatedAt},
      "lastError" = ${r.lastError},
      "lastErrorAt" = ${r.lastErrorAt},
      "rejectedReading" = ${rejected}::jsonb
    WHERE "id" = ${r.id}`;
}

export type DailyStatRows = Prisma.ProductDailyStatGetPayload<object>[];

/** Story 18.7: faithful snapshot/restore of the whole `Product_Daily_Stats` table. */
export const snapshotDailyStats = (
  prisma: PrismaService,
): Promise<DailyStatRows> => prisma.productDailyStat.findMany();

export async function restoreDailyStats(
  prisma: PrismaService,
  rows: DailyStatRows,
): Promise<void> {
  await prisma.productDailyStat.deleteMany();
  if (rows.length) {
    await prisma.productDailyStat.createMany({
      data: rows,
      skipDuplicates: true,
    });
  }
}
