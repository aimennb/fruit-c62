-- Restaure isActive sur Unit & ProductCategory (référentiels, cohérent avec les autres modèles).
-- Idempotent : ne plante pas si déjà présent.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='Unit' AND column_name='isActive') THEN
    ALTER TABLE "Unit" ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='ProductCategory' AND column_name='isActive') THEN
    ALTER TABLE "ProductCategory" ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;
  END IF;
END $$;
