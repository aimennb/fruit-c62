-- Rend purchaseId nullable pour permettre les bulletins autonomes (sans Purchase lié).
ALTER TABLE "SupplierAdvanceAllocation" ALTER COLUMN "purchaseId" DROP NOT NULL;

-- Remplace l'unicité (advanceId, purchaseId) par (advanceId, purchaseBulletinId)
-- car l'affectation se fait sur le bulletin.
ALTER TABLE "SupplierAdvanceAllocation" DROP CONSTRAINT "SupplierAdvanceAllocation_advanceId_purchaseId_key";
ALTER TABLE "SupplierAdvanceAllocation" ADD CONSTRAINT "SupplierAdvanceAllocation_advanceId_purchaseBulletinId_key" UNIQUE ("advanceId", "purchaseBulletinId");
