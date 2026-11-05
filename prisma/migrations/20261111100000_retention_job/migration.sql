BEGIN;
-- Story 20.8 (AD-101, FR-130..132, A105): what the retention job needs and nothing else.
--
-- Additive and atomic. No function, no trigger, no DELETE or UPDATE of existing rows. An undeclared
-- `lock_timeout` is deliberate (docs/deployment.md 12.2): deploy.sh bounds the wait.
--
-- 1. "Retention_Runs" (created by 20.7, mutable on purpose, A105) gains three nullable columns (no table
--    rewrite) and the guarantee that two runs can never be RUNNING at the same time.
--      "effectiveNow"  the clock the run used for every cut-off (see RetentionClock): the database clock,
--                      never further than RETENTION_MAX_CLOCK_ADVANCE_HOURS past the previous run's.
--      "auditedAt"     when RETENTION_PURGE_RUN was written; NULL = not written yet (the audit log was
--                      unavailable): the next run writes it, so no purge stays unaudited for good.
--      "errorSummary"  a short code (never a message) of a failure of the run itself.
ALTER TABLE "Retention_Runs"
  ADD COLUMN "effectiveNow" TIMESTAMPTZ(3),
  ADD COLUMN "auditedAt"    TIMESTAMPTZ(3),
  ADD COLUMN "errorSummary" VARCHAR(200);

-- The session advisory lock (2120002) already keeps two instances apart; this index is the second wall:
-- even if a lock were lost (a dropped connection), the second INSERT of a RUNNING row fails (23505).
CREATE UNIQUE INDEX "Retention_Runs_one_running_key" ON "Retention_Runs" ("status") WHERE "status" = 'RUNNING';

-- 2. Indexes for the expiry columns the purge filters on. Without them every batch is a scan of the whole
--    table (sessions and carts are the hot tables of the shop). Plain CREATE INDEX (a transaction cannot
--    hold CONCURRENTLY): it blocks writes to the table only while it builds, and these tables hold
--    thousands of rows, not millions (a build is milliseconds).
CREATE INDEX "Carts_expiresAt_idx"                  ON "Carts" ("expiresAt");
CREATE INDEX "Wishlists_expiresAt_idx"              ON "Wishlists" ("expiresAt");
CREATE INDEX "Contact_Inquiries_createdAt_idx"      ON "Contact_Inquiries" ("createdAt");
CREATE INDEX "Admin_Sessions_expiresAt_idx"         ON "Admin_Sessions" ("expiresAt");
CREATE INDEX "Customer_Sessions_expiresAt_idx"      ON "Customer_Sessions" ("expiresAt");
CREATE INDEX "Customer_Verifications_expiresAt_idx" ON "Customer_Verifications" ("expiresAt");
CREATE INDEX "Revoked_Tokens_expiresAt_idx"         ON "Revoked_Tokens" ("expiresAt");
COMMIT;
