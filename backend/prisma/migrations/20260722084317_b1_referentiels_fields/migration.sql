-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "commune" TEXT,
ADD COLUMN     "nameAr" TEXT,
ADD COLUMN     "nif" TEXT,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "paymentTerms" TEXT,
ADD COLUMN     "wilaya" TEXT;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "alertThreshold" DECIMAL(14,2),
ADD COLUMN     "avgPurchasePrice" DECIMAL(14,2),
ADD COLUMN     "calibre" TEXT,
ADD COLUMN     "lastPurchasePrice" DECIMAL(14,2),
ADD COLUMN     "nameAr" TEXT,
ADD COLUMN     "nameBer" TEXT,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "origin" TEXT,
ADD COLUMN     "packaging" TEXT,
ADD COLUMN     "quality" TEXT,
ADD COLUMN     "suggestedSalePrice" DECIMAL(14,2),
ADD COLUMN     "variety" TEXT;

-- AlterTable
ALTER TABLE "Supplier" ADD COLUMN     "commune" TEXT,
ADD COLUMN     "country" TEXT DEFAULT 'Algérie',
ADD COLUMN     "nameAr" TEXT,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "wilaya" TEXT;
