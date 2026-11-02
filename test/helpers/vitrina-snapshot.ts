/**
 * Story 18.8: byte-faithful snapshot/restore of the four Vitrina tables
 * (`Product_Score_Runs`, `Product_Scores`, `Vitrina_Algorithm_Settings`,
 * `Vitrina_Algorithm_Audits`). Rows travel as `to_jsonb` text and come back
 * through `jsonb_populate_recordset`, so timestamps keep their microseconds
 * and decimals their scale (a row-by-row Prisma restore would not).
 * `exec` is any "run this SQL with params" function (pg client or Prisma).
 */
export interface VitrinaSnapshot {
  runs: string;
  scores: string;
  audits: string;
  settings: string;
}
type Exec = (
  sql: string,
  params?: unknown[],
) => Promise<Record<string, unknown>[]>;

const agg = async (
  exec: Exec,
  table: string,
  order: string,
): Promise<string> => {
  const r = await exec(
    `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY ${order}), '[]'::jsonb)::text AS j FROM "${table}" t`,
  );
  return r[0].j as string;
};

export async function snapshotVitrina(exec: Exec): Promise<VitrinaSnapshot> {
  return {
    runs: await agg(exec, 'Product_Score_Runs', 't."id"'),
    scores: await agg(exec, 'Product_Scores', 't."runId", t."productId"'),
    audits: await agg(exec, 'Vitrina_Algorithm_Audits', 't."id"'),
    settings: await agg(exec, 'Vitrina_Algorithm_Settings', 't."id"'),
  };
}

/** Caller supplies the transaction boundary (BEGIN/COMMIT) when it needs one. */
export async function restoreVitrina(
  exec: Exec,
  s: VitrinaSnapshot,
): Promise<void> {
  await exec(`DELETE FROM "Product_Score_Runs"`); // cascades Product_Scores
  await exec(`DELETE FROM "Vitrina_Algorithm_Audits"`);
  await exec(
    `INSERT INTO "Product_Score_Runs"
     SELECT * FROM jsonb_populate_recordset(null::"Product_Score_Runs", $1::jsonb)`,
    [s.runs],
  );
  await exec(
    `INSERT INTO "Product_Scores"
     SELECT r.* FROM jsonb_populate_recordset(null::"Product_Scores", $1::jsonb) r
     WHERE EXISTS (SELECT 1 FROM "Products" p WHERE p."id" = r."productId")
       AND EXISTS (SELECT 1 FROM "Product_Score_Runs" x WHERE x."id" = r."runId")`,
    [s.scores],
  );
  await exec(
    `INSERT INTO "Vitrina_Algorithm_Audits" ("id","adminUserId","before","after","createdAt")
     SELECT r."id",
            CASE WHEN EXISTS (SELECT 1 FROM "Admin_Users" a WHERE a."id" = r."adminUserId")
                 THEN r."adminUserId" END,
            r."before", r."after", r."createdAt"
     FROM jsonb_populate_recordset(null::"Vitrina_Algorithm_Audits", $1::jsonb) r`,
    [s.audits],
  );
  // Settings singleton: put the original row back verbatim (updatedAt too).
  await exec(`DELETE FROM "Vitrina_Algorithm_Settings"`);
  await exec(
    `INSERT INTO "Vitrina_Algorithm_Settings"
       ("id","wSales","wRevenue","wVelocity","wInterest","wNovelty","halfLifeDays",
        "windowDays","noveltyDays","maxPerFranchise","mmrLambda","priorM",
        "scarcityThreshold","minSalesForRanking","viewDayCap","currentRunId",
        "updatedAt","updatedById")
     SELECT r."id",r."wSales",r."wRevenue",r."wVelocity",r."wInterest",r."wNovelty",
            r."halfLifeDays",r."windowDays",r."noveltyDays",r."maxPerFranchise",
            r."mmrLambda",r."priorM",r."scarcityThreshold",r."minSalesForRanking",
            r."viewDayCap",
            CASE WHEN EXISTS (SELECT 1 FROM "Product_Score_Runs" x WHERE x."id" = r."currentRunId")
                 THEN r."currentRunId" END,
            r."updatedAt",
            CASE WHEN EXISTS (SELECT 1 FROM "Admin_Users" a WHERE a."id" = r."updatedById")
                 THEN r."updatedById" END
     FROM jsonb_populate_recordset(null::"Vitrina_Algorithm_Settings", $1::jsonb) r`,
    [s.settings],
  );
}

/** Stable digest of the four tables (used to prove "untouched"). */
export async function vitrinaDigest(exec: Exec): Promise<string> {
  const s = await snapshotVitrina(exec);
  return JSON.stringify(s);
}
