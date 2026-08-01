-- B.4 — Suivi des avances fournisseurs (champs de suivi + statut DISPONIBLE)
-- Ajoute les champs permettant le calcul des soldes d'avance (§29-§33).

-- AlterEnum AdvanceStatus : ajout de DISPONIBLE au début de l'enum.
ALTER TYPE "AdvanceStatus" ADD VALUE 'DISPONIBLE';

-- SupplierAdvance : montants suivis (affecté / remboursé).
ALTER TABLE "SupplierAdvance" ADD COLUMN     "allocatedAmount" DECIMAL(14,2) NOT NULL DEFAULT 0;
ALTER TABLE "SupplierAdvance" ADD COLUMN     "refundedAmount" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- SupplierAdvanceAllocation : lien bulletin + unicité (avance, achat).
ALTER TABLE "SupplierAdvanceAllocation" ADD COLUMN     "purchaseBulletinId" TEXT;
ALTER TABLE "SupplierAdvanceAllocation" ADD CONSTRAINT "SupplierAdvanceAllocation_advanceId_purchaseId_key" UNIQUE ("advanceId", "purchaseId");
CREATE INDEX "SupplierAdvanceAllocation_purchaseBulletinId_idx" ON "SupplierAdvanceAllocation"("purchaseBulletinId");

-- PurchaseBulletin : montant déjà payé/déduit.
ALTER TABLE "PurchaseBulletin" ADD COLUMN     "paidAmount" DECIMAL(14,2) NOT NULL DEFAULT 0;
