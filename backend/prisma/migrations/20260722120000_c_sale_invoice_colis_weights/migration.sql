-- AlterTable : champs bulletin de vente (Colis / Brut / Tare / Net) sur SaleItem
ALTER TABLE "SaleItem" ADD COLUMN "colis" DECIMAL(14,3) NOT NULL DEFAULT 0;
ALTER TABLE "SaleItem" ADD COLUMN "grossWeight" DECIMAL(14,3) NOT NULL DEFAULT 0;
ALTER TABLE "SaleItem" ADD COLUMN "tare" DECIMAL(14,3) NOT NULL DEFAULT 0;
ALTER TABLE "SaleItem" ADD COLUMN "netWeight" DECIMAL(14,3) NOT NULL DEFAULT 0;

-- AlterTable : mêmes champs sur InvoiceItem (recopiés depuis SaleItem)
ALTER TABLE "InvoiceItem" ADD COLUMN "colis" DECIMAL(14,3) NOT NULL DEFAULT 0;
ALTER TABLE "InvoiceItem" ADD COLUMN "grossWeight" DECIMAL(14,3) NOT NULL DEFAULT 0;
ALTER TABLE "InvoiceItem" ADD COLUMN "tare" DECIMAL(14,3) NOT NULL DEFAULT 0;
ALTER TABLE "InvoiceItem" ADD COLUMN "netWeight" DECIMAL(14,3) NOT NULL DEFAULT 0;
