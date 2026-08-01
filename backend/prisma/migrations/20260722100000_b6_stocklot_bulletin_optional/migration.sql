-- Rendre bulletinId nullable sur StockLot (un lot d'inventaire initial n'a pas de bulletin d'achat).
ALTER TABLE "StockLot" ALTER COLUMN "bulletinId" DROP NOT NULL;
