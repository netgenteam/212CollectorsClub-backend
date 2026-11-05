BEGIN;
-- Story 20.8, round 4: the retention clock is the database clock with no cap, so the anchor columns that the
-- capped clock of round 2 added (20261113100000_retention_clock_anchor) are not read or written any more.
-- Dropping a column is a catalog change (no table rewrite). Only counters/anchors of the job's own history go;
-- nothing personal. An undeclared `lock_timeout` is deliberate (docs/deployment.md 12.2): deploy.sh bounds it.
ALTER TABLE "Retention_Runs"
  DROP COLUMN "clockClamped",
  DROP COLUMN "bootId",
  DROP COLUMN "uptimeMs";
COMMIT;
