-- AlterTable
ALTER TABLE "Admin_Users" ADD COLUMN     "emailVerified" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "image" TEXT;

-- CreateTable
CREATE TABLE "Admin_Sessions" (
    "id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Admin_Sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Admin_Accounts" (
    "id" UUID NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Admin_Accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Admin_Sessions_token_key" ON "Admin_Sessions"("token");

-- CreateIndex
CREATE INDEX "Admin_Sessions_userId_idx" ON "Admin_Sessions"("userId");

-- CreateIndex
CREATE INDEX "Admin_Accounts_userId_idx" ON "Admin_Accounts"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Admin_Accounts_providerId_accountId_key" ON "Admin_Accounts"("providerId", "accountId");

-- AddForeignKey
ALTER TABLE "Admin_Sessions" ADD CONSTRAINT "Admin_Sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Admin_Users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Admin_Accounts" ADD CONSTRAINT "Admin_Accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Admin_Users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Story 12.2 (AD-26): backfill. Every existing AdminUser gets its credential
-- account with the current Argon2id digest, so admins log in with the same
-- password (no reset). "passwordHash" and "Revoked_Tokens" are kept (rollback).
INSERT INTO "Admin_Accounts" ("id", "accountId", "providerId", "userId", "password", "createdAt", "updatedAt")
SELECT gen_random_uuid(), u."id"::text, 'credential', u."id", u."passwordHash", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Admin_Users" u
ON CONFLICT ("providerId", "accountId") DO NOTHING;
