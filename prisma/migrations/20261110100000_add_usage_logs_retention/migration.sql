BEGIN;
-- Story 20.7 (AD-100, AD-101, A95, A102, A105): the usage log (every HTTP request, 7 days) and the table
-- Story 20.8's retention job writes its runs to (created here so 20.8 needs no second migration).
--
-- Additive and atomic: two new tables, nothing existing is read, rewritten or locked beyond the foreign
-- key of "Retention_Runs" to "Admin_Users" (a brief share lock on that table's key). An undeclared
-- `lock_timeout` is deliberate (docs/deployment.md 12.2): deploy.sh bounds the wait.
--
-- "Usage_Logs" is MUTABLE ON PURPOSE and separate from "Audit_Events" (A95): it holds the IP and the user
-- agent of every visitor for 7 days, so rows must be deletable (the purge and the anonymization of an
-- account delete them). It is never evidence. Rows are written once and never updated, so the
-- application role gets no UPDATE and no TRUNCATE on it (below); it keeps SELECT, INSERT and DELETE.
--
-- No partitioning (A102): Prisma does not model partitioned tables and a shop's volume does not need it;
-- the purge deletes in batches of 1 000 by "ts". Review it if the table exceeds ~5 M rows per day.
--
-- Column "actorType" is a CHECKed varchar (like "Audit_Events"."actorType"), not an enum type: adding a kind
-- of actor later is a CHECK change, not an ALTER TYPE.
CREATE TABLE "Usage_Logs" (
  "id"         BIGSERIAL    NOT NULL,
  "ts"         TIMESTAMPTZ(3) NOT NULL,
  "method"     VARCHAR(10)  NOT NULL,
  "route"      VARCHAR(200) NOT NULL,
  "status"     SMALLINT     NOT NULL,
  "durationMs" INTEGER      NOT NULL,
  "actorType"  VARCHAR(16)  NOT NULL,
  "actorId"    UUID,
  "ip"         INET,
  "userAgent"  VARCHAR(200),
  "requestId"  UUID         NOT NULL,
  CONSTRAINT "Usage_Logs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Usage_Logs_actorType_check" CHECK ("actorType" IN ('ADMIN', 'CUSTOMER', 'ANON')),
  CONSTRAINT "Usage_Logs_status_check" CHECK ("status" BETWEEN 0 AND 599),
  CONSTRAINT "Usage_Logs_durationMs_check" CHECK ("durationMs" >= 0)
);

CREATE INDEX "Usage_Logs_ts_idx" ON "Usage_Logs" ("ts");
CREATE INDEX "Usage_Logs_actorId_ts_idx" ON "Usage_Logs" ("actorId", "ts");
CREATE INDEX "Usage_Logs_route_ts_idx" ON "Usage_Logs" ("route" varchar_pattern_ops, "ts");
CREATE INDEX "Usage_Logs_status_ts_idx" ON "Usage_Logs" ("status", "ts");
CREATE INDEX "Usage_Logs_ip_ts_idx" ON "Usage_Logs" ("ip", "ts");
CREATE INDEX "Usage_Logs_requestId_idx" ON "Usage_Logs" ("requestId");

-- A table of operation (A105): admits UPDATE. Written by Story 20.8's retention job.
CREATE TABLE "Retention_Runs" (
  "id"            UUID           NOT NULL DEFAULT gen_random_uuid(),
  "trigger"       VARCHAR(16)    NOT NULL,
  "triggeredById" UUID,
  "startedAt"     TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "finishedAt"    TIMESTAMPTZ(3),
  "status"        VARCHAR(16)    NOT NULL,
  "tasks"         JSONB          NOT NULL DEFAULT '[]',
  CONSTRAINT "Retention_Runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Retention_Runs_trigger_check" CHECK ("trigger" IN ('SCHEDULED', 'MANUAL')),
  CONSTRAINT "Retention_Runs_status_check" CHECK ("status" IN ('RUNNING', 'OK', 'PARTIAL', 'FAILED')),
  CONSTRAINT "Retention_Runs_triggeredById_fkey" FOREIGN KEY ("triggeredById")
    REFERENCES "Admin_Users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "Retention_Runs_startedAt_idx" ON "Retention_Runs" ("startedAt");

-- Least privilege for the application roles that already exist (`pnpm db:roles` does the same for the
-- ones created later; scripts/db-roles.sql). `collectorsclub_<env>_app` is the naming of that script.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname ~ '^collectorsclub_[a-z0-9_]{1,30}_app$' LOOP
    EXECUTE format('REVOKE UPDATE, TRUNCATE, REFERENCES, TRIGGER ON "Usage_Logs" FROM %I', r.rolname);
  END LOOP;
END
$$;
COMMIT;
