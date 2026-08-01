-- B.1 (complément) — champs isActive sur Unit / ProductCategory
-- Cohérence avec routes referentiels (units.routes.ts / product-categories.routes.ts).

ALTER TABLE "Unit" ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;
CREATE INDEX "Unit_isActive_idx" ON "Unit"("isActive");

ALTER TABLE "ProductCategory" ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;
CREATE INDEX "ProductCategory_isActive_idx" ON "ProductCategory"("isActive");
