-- B.3 — Validation bulletin + Stock (lots, mouvements, pertes, annulation)
-- Migration additive : aucune perte de données.

-- 1) Enum BulletinStatus : ajout de CANCELLED
ALTER TYPE "BulletinStatus" ADD VALUE 'CANCELLED';

-- 2) PurchaseBulletin : champs validation + archivage PDF
ALTER TABLE "PurchaseBulletin" ADD COLUMN "validatedAt" TIMESTAMP(3);
ALTER TABLE "PurchaseBulletin" ADD COLUMN "archivedPdfPath" TEXT;

-- 3) PurchaseBulletinItem : coûts & qualité par ligne
ALTER TABLE "PurchaseBulletinItem" ADD COLUMN "transportCost" DECIMAL(14,2) NOT NULL DEFAULT 0;
ALTER TABLE "PurchaseBulletinItem" ADD COLUMN "fees" DECIMAL(14,2) NOT NULL DEFAULT 0;
ALTER TABLE "PurchaseBulletinItem" ADD COLUMN "remises" DECIMAL(14,2) NOT NULL DEFAULT 0;
ALTER TABLE "PurchaseBulletinItem" ADD COLUMN "origine" TEXT;
ALTER TABLE "PurchaseBulletinItem" ADD COLUMN "qualite" TEXT;
ALTER TABLE "PurchaseBulletinItem" ADD COLUMN "calibre" TEXT;

-- 4) StockLot : champs métier (lot, fournisseur, bulletin, coûts, poids, qualité)
-- (les colonnes existantes de la version init sont étendues ici)
ALTER TABLE "StockLot" ADD COLUMN "lotNumber" TEXT;
ALTER TABLE "StockLot" ADD COLUMN "supplierId" TEXT;
ALTER TABLE "StockLot" ADD COLUMN "bulletinId" TEXT;
ALTER TABLE "StockLot" ADD COLUMN "purchasePrice" DECIMAL(14,2) NOT NULL DEFAULT 0;
ALTER TABLE "StockLot" ADD COLUMN "realCost" DECIMAL(14,2) NOT NULL DEFAULT 0;
ALTER TABLE "StockLot" ADD COLUMN "arrivalDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "StockLot" ADD COLUMN "unitSymbol" TEXT;
ALTER TABLE "StockLot" ADD COLUMN "grossWeight" DECIMAL(14,3) NOT NULL DEFAULT 0;
ALTER TABLE "StockLot" ADD COLUMN "tare" DECIMAL(14,3) NOT NULL DEFAULT 0;
ALTER TABLE "StockLot" ADD COLUMN "netWeight" DECIMAL(14,3) NOT NULL DEFAULT 0;
ALTER TABLE "StockLot" ADD COLUMN "origin" TEXT;
ALTER TABLE "StockLot" ADD COLUMN "quality" TEXT;
ALTER TABLE "StockLot" ADD COLUMN "caliber" TEXT;

-- 5) Contraintes FK & index pour StockLot
ALTER TABLE "StockLot" ADD CONSTRAINT "StockLot_supplierId_fkey"
  FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockLot" ADD CONSTRAINT "StockLot_bulletinId_fkey"
  FOREIGN KEY ("bulletinId") REFERENCES "PurchaseBulletin"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "StockLot_lotNumber_key" ON "StockLot"("lotNumber");
CREATE INDEX "StockLot_supplierId_idx" ON "StockLot"("supplierId");
CREATE INDEX "StockLot_bulletinId_idx" ON "StockLot"("bulletinId");
