ALTER TABLE "SupplierPayment" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'en_attente';
