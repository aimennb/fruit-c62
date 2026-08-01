-- CreateTable
CREATE TABLE "SupplierPayment" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "ean13" TEXT,
    "supplierId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mode" TEXT NOT NULL DEFAULT 'PAY',
    "method" "PaymentMethod" NOT NULL DEFAULT 'CASH',
    "totalAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "SupplierPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierPaymentLine" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "bordereauId" TEXT NOT NULL,
    "montant" DECIMAL(14,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierPaymentLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SupplierPayment_reference_key" ON "SupplierPayment"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierPayment_ean13_key" ON "SupplierPayment"("ean13");

-- CreateIndex
CREATE INDEX "SupplierPayment_supplierId_idx" ON "SupplierPayment"("supplierId");

-- CreateIndex
CREATE INDEX "SupplierPayment_date_idx" ON "SupplierPayment"("date");

-- CreateIndex
CREATE INDEX "SupplierPayment_deletedAt_idx" ON "SupplierPayment"("deletedAt");

-- CreateIndex
CREATE INDEX "SupplierPaymentLine_paymentId_idx" ON "SupplierPaymentLine"("paymentId");

-- CreateIndex
CREATE INDEX "SupplierPaymentLine_bordereauId_idx" ON "SupplierPaymentLine"("bordereauId");

-- AddForeignKey
ALTER TABLE "SupplierPayment" ADD CONSTRAINT "SupplierPayment_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierPaymentLine" ADD CONSTRAINT "SupplierPaymentLine_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "SupplierPayment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierPaymentLine" ADD CONSTRAINT "SupplierPaymentLine_bordereauId_fkey" FOREIGN KEY ("bordereauId") REFERENCES "SupplierBordereau"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

