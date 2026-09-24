-- CreateTable
CREATE TABLE "Revoked_Tokens" (
    "jti" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Revoked_Tokens_pkey" PRIMARY KEY ("jti")
);
