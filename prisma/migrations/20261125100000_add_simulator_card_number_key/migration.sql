-- NO explicit BEGIN/COMMIT on purpose: Postgres runs a multi-statement script as ONE implicit transaction (all or
-- nothing), and with an explicit BEGIN Prisma hides the RAISE message behind "current transaction is aborted".
-- Story 22.10 (AD-106, FR-149/150): card numbers are unique per set WITHOUT distinguishing case ("A1" = "a1").
-- Same pattern as "Simulator_Sets"."nameKey": a plain column maintained by the service (lower(number)), so Prisma
-- sees no drift (a functional index would). Additive: no data is deleted or rewritten.
--
-- ROLLBACK (manual):
--   DROP INDEX "Simulator_Cards_setId_numberKey_key";
--   CREATE UNIQUE INDEX "Simulator_Cards_setId_number_key" ON "Simulator_Cards"("setId", "number");
--   ALTER TABLE "Simulator_Cards" DROP COLUMN "numberKey";
-- (case-distinct numbers remain valid under the old case-sensitive unique).

-- AlterTable
ALTER TABLE "Simulator_Cards" ADD COLUMN "numberKey" VARCHAR(64);

-- Backfill (numbers are stored trimmed; NULL stays NULL)
UPDATE "Simulator_Cards" SET "numberKey" = lower("number") WHERE "number" IS NOT NULL;

-- Fail with a clear message (and change nothing) if two cards of one set differ only by case.
DO $$
DECLARE
  dup RECORD;
  msg TEXT := '';
BEGIN
  FOR dup IN
    SELECT "setId", "numberKey", count(*) AS n, string_agg("number", ', ' ORDER BY "number") AS numbers
      FROM "Simulator_Cards"
     WHERE "numberKey" IS NOT NULL
     GROUP BY "setId", "numberKey"
    HAVING count(*) > 1
     LIMIT 10
  LOOP
    msg := msg || format(E'\n  set %s: numbers [%s]', dup."setId", dup.numbers);
  END LOOP;
  IF msg <> '' THEN
    RAISE EXCEPTION 'Story 22.10 migration aborted: cards of the same set share a number that differs only by upper/lower case. Rename or delete the duplicates, then re-run (first 10 shown):%', msg;
  END IF;
END $$;

-- DropIndex
DROP INDEX "Simulator_Cards_setId_number_key";

-- CreateIndex (several NULL keys in one set stay allowed)
CREATE UNIQUE INDEX "Simulator_Cards_setId_numberKey_key" ON "Simulator_Cards"("setId", "numberKey");
