/*
  Warnings:

  - You are about to drop the column `amount` on the `PurchaseBulletinItem` table. All the data in the column will be lost.
  - You are about to drop the column `weight` on the `PurchaseBulletinItem` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "BulletinStatus" AS ENUM ('DRAFT', 'VALIDATED');

-- DropForeignKey
ALTER TABLE "PurchaseBulletin" DROP CONSTRAINT "PurchaseBulletin_purchaseId_fkey";

-- AlterTable
ALTER TABLE "PurchaseBulletin" ADD COLUMN     "consigne" TEXT,
ADD COLUMN     "deliveredTo" TEXT,
ADD COLUMN     "emballage" TEXT,
ADD COLUMN     "marque" TEXT,
ADD COLUMN     "status" "BulletinStatus" NOT NULL DEFAULT 'DRAFT',
ALTER COLUMN "purchaseId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "PurchaseBulletinItem" DROP COLUMN "amount",
DROP COLUMN "weight",
ADD COLUMN     "marque" TEXT,
ADD COLUMN     "montant" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "nbrColis" DECIMAL(14,3) NOT NULL DEFAULT 0,
ADD COLUMN     "poidsBrut" DECIMAL(14,3) NOT NULL DEFAULT 0,
ADD COLUMN     "poidsNet" DECIMAL(14,3) NOT NULL DEFAULT 0,
ADD COLUMN     "prixUnitaire" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "tare" DECIMAL(14,3) NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "PurchaseBulletin_status_idx" ON "PurchaseBulletin"("status");

-- AddForeignKey
ALTER TABLE "PurchaseBulletin" ADD CONSTRAINT "PurchaseBulletin_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase"("id") ON DELETE SET NULL ON UPDATE CASCADE;
