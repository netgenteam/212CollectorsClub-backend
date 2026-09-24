-- CreateTable
CREATE TABLE "Admin_Users" (
    "id" UUID NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "roleTier" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Admin_Users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Admin_Users_username_key" ON "Admin_Users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "Admin_Users_email_key" ON "Admin_Users"("email");

-- AddForeignKey
ALTER TABLE "Order_Status_History" ADD CONSTRAINT "Order_Status_History_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "Admin_Users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
