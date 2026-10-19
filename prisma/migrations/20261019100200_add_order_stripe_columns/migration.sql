-- AlterTable
-- Story 14.3 (AD-44): additive Stripe correlation columns on Orders.
ALTER TABLE "Orders" ADD COLUMN     "stripeCheckoutSessionId" TEXT,
ADD COLUMN     "stripePaymentIntentId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Orders_stripeCheckoutSessionId_key" ON "Orders"("stripeCheckoutSessionId");

-- CreateIndex
CREATE INDEX "Orders_stripePaymentIntentId_idx" ON "Orders"("stripePaymentIntentId");
