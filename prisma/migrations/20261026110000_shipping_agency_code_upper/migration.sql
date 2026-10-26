-- Agency codes are upper-case (admin POST normalizes to ^[A-Z0-9_-]{2,50}$) and
-- the column must fit that range. Additive/idempotent: widen, then upper-case
-- only rows whose upper-case form is not already taken (no data loss).
ALTER TABLE "Shipping_Agencies" ALTER COLUMN "code" TYPE VARCHAR(50);

UPDATE "Shipping_Agencies" a
SET "code" = upper(a."code")
WHERE a."code" <> upper(a."code")
  AND NOT EXISTS (
    SELECT 1 FROM "Shipping_Agencies" b
    WHERE b."code" = upper(a."code") AND b."id" <> a."id"
  );
