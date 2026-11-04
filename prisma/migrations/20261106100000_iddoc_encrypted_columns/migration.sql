BEGIN;
-- Story 20.3 (AD-96, FR-123/124/127/128): PHASE 1 (expand) of the encrypted ID document.
-- 100 % additive: no column is dropped or rewritten, no row is touched, and the build
-- that is running now keeps working (it ignores the new columns; the only relaxed
-- constraint is NOT NULL on "Customer_Addresses"."recipientIdDoc").
--
-- Atomic on purpose (docs/deployment.md 12.3): everything below commits or nothing
-- does, so a failed attempt leaves nothing behind and only
-- `prisma migrate resolve --rolled-back` + a retry is needed. The locks are taken
-- FIRST, in a fixed order (Customer_Addresses is small and rarely written; "Orders"
-- is the hot table), and are held only for the milliseconds the metadata changes
-- and the three small btree builds take. `deploy.sh` bounds the WAIT with
-- lock_timeout (MIGRATE_LOCK_TIMEOUT_MS); this SET LOCAL repeats the bound for a
-- manual run through a client that honours it.
SET LOCAL lock_timeout = '10s';
LOCK TABLE "Customer_Addresses" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "Orders" IN ACCESS EXCLUSIVE MODE;

CREATE TYPE "BuyerIdType" AS ENUM ('V', 'E', 'J', 'P', 'G');

ALTER TABLE "Orders"
  ADD COLUMN "recipientIdDocEnc" TEXT,
  ADD COLUMN "recipientIdDocBlind" VARCHAR(64),
  ADD COLUMN "buyerIdType" "BuyerIdType",
  ADD COLUMN "buyerIdDocEnc" TEXT,
  ADD COLUMN "buyerIdDocBlind" VARCHAR(64),
  ADD COLUMN "buyerLegalName" VARCHAR(200);

ALTER TABLE "Customer_Addresses"
  ADD COLUMN "recipientIdDocEnc" TEXT,
  ADD COLUMN "recipientIdDocBlind" VARCHAR(64),
  ALTER COLUMN "recipientIdDoc" DROP NOT NULL;

-- Equality lookups by blind index only (never LIKE). Plain (non-CONCURRENT) builds:
-- they run inside this transaction and both tables are small.
CREATE INDEX "Orders_recipientIdDocBlind_idx" ON "Orders"("recipientIdDocBlind");
CREATE INDEX "Orders_buyerIdDocBlind_idx" ON "Orders"("buyerIdDocBlind");
CREATE INDEX "Customer_Addresses_recipientIdDocBlind_idx" ON "Customer_Addresses"("recipientIdDocBlind");
COMMIT;
