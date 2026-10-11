-- CreateTable
CREATE TABLE "Customers" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer_Sessions" (
    "id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_Sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer_Accounts" (
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

    CONSTRAINT "Customer_Accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer_Verifications" (
    "id" UUID NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_Verifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Customers_email_key" ON "Customers"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_Sessions_token_key" ON "Customer_Sessions"("token");

-- CreateIndex
CREATE INDEX "Customer_Sessions_userId_idx" ON "Customer_Sessions"("userId");

-- CreateIndex
CREATE INDEX "Customer_Accounts_userId_idx" ON "Customer_Accounts"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_Accounts_providerId_accountId_key" ON "Customer_Accounts"("providerId", "accountId");

-- CreateIndex
CREATE INDEX "Customer_Verifications_identifier_idx" ON "Customer_Verifications"("identifier");

-- AddForeignKey
ALTER TABLE "Customer_Sessions" ADD CONSTRAINT "Customer_Sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer_Accounts" ADD CONSTRAINT "Customer_Accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
