-- CreateTable
-- Story 14.3 (AD-44): webhook idempotency ledger (no FK to Orders on purpose).
CREATE TABLE "Stripe_Webhook_Events" (
    "eventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "orderId" UUID,
    "outcome" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Stripe_Webhook_Events_pkey" PRIMARY KEY ("eventId")
);
