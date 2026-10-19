-- Story 14.6 (AD-49): complete PayPal removal.
-- Postgres cannot DROP an enum value, so both enums are recreated.

-- Guard: abort (the whole migration is transactional) if any PayPal data remains.
DO $$
DECLARE
  n bigint;
  m bigint;
BEGIN
  SELECT count(*) INTO n FROM "Orders" WHERE "paymentRail"::text = 'PAYPAL';
  SELECT count(*) INTO m FROM "Order_Status_History" WHERE "actorType"::text = 'PAYPAL_WEBHOOK';
  IF n > 0 OR m > 0 THEN
    RAISE EXCEPTION 'PAYPAL_REMOVAL_ABORTED: % orders / % history rows still reference PayPal; delete or archive them before migrating', n, m;
  END IF;
END $$;

-- Order.paypalOrderId (its unique index is dropped with the column)
DROP INDEX IF EXISTS "Orders_paypalOrderId_key";
ALTER TABLE "Orders" DROP COLUMN "paypalOrderId";

-- PaymentRail: {PAGO_MOVIL, STRIPE}
CREATE TYPE "PaymentRail_new" AS ENUM ('PAGO_MOVIL', 'STRIPE');
ALTER TABLE "Orders" ALTER COLUMN "paymentRail" TYPE "PaymentRail_new" USING ("paymentRail"::text::"PaymentRail_new");
DROP TYPE "PaymentRail";
ALTER TYPE "PaymentRail_new" RENAME TO "PaymentRail";

-- OrderActorType: {SYSTEM, STRIPE_WEBHOOK, ADMIN, CRON}
CREATE TYPE "OrderActorType_new" AS ENUM ('SYSTEM', 'STRIPE_WEBHOOK', 'ADMIN', 'CRON');
ALTER TABLE "Order_Status_History" ALTER COLUMN "actorType" TYPE "OrderActorType_new" USING ("actorType"::text::"OrderActorType_new");
DROP TYPE "OrderActorType";
ALTER TYPE "OrderActorType_new" RENAME TO "OrderActorType";
