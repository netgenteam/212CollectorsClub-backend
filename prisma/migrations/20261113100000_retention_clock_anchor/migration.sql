BEGIN;
-- Story 20.8, second round: the retention clock is limited by the REAL time that elapsed between two runs, not by
-- the number of runs. To measure it a run stores, at the moment it fixes its clock, the identity of the boot of the
-- machine and the host's uptime counter (neither moves when the wall clock jumps), plus whether the clock was
-- capped ("clockClamped"), so GET /admin/retention/runs can show it.
--
-- Three columns, all additive: a NOT NULL boolean with a constant default (no table rewrite on PostgreSQL 11+) and
-- two nullable ones. Rows written before this migration have no anchor: the next run treats the elapsed time as
-- unverified (it advances at most RETENTION_MAX_CLOCK_ADVANCE_HOURS once) and writes its own anchor.
-- An undeclared `lock_timeout` is deliberate (docs/deployment.md 12.2): deploy.sh bounds it.
ALTER TABLE "Retention_Runs"
  ADD COLUMN "clockClamped" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "bootId" VARCHAR(64),
  ADD COLUMN "uptimeMs" BIGINT;
COMMIT;
