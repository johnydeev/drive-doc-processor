-- Rename LspService.provider → providerName (expand-contract)

-- Step 1: Add new column
ALTER TABLE "LspService" ADD COLUMN "providerName" TEXT;

-- Step 2: Copy data
UPDATE "LspService" SET "providerName" = "provider";

-- Step 3: Make NOT NULL after copy
ALTER TABLE "LspService" ALTER COLUMN "providerName" SET NOT NULL;

-- Step 4: Drop old unique constraint and index, create new ones
ALTER TABLE "LspService" DROP CONSTRAINT IF EXISTS "LspService_consortiumId_provider_clientNumber_key";
DROP INDEX IF EXISTS "LspService_clientId_provider_clientNumber_idx";

ALTER TABLE "LspService" ADD CONSTRAINT "LspService_consortiumId_providerName_clientNumber_key"
  UNIQUE ("consortiumId", "providerName", "clientNumber");
CREATE INDEX "LspService_clientId_providerName_clientNumber_idx"
  ON "LspService" ("clientId", "providerName", "clientNumber");

-- Step 5: Drop old column
ALTER TABLE "LspService" DROP COLUMN "provider";
