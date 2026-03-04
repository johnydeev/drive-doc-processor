-- CreateEnum
CREATE TYPE "ClientRole" AS ENUM ('ADMIN', 'CLIENT');

-- AlterTable
ALTER TABLE "Client"
  ADD COLUMN "email" TEXT,
  ADD COLUMN "passwordHash" TEXT,
  ADD COLUMN "role" "ClientRole" NOT NULL DEFAULT 'CLIENT';

ALTER TABLE "Client"
  ALTER COLUMN "driveFolderPending" DROP NOT NULL,
  ALTER COLUMN "driveFolderProcessed" DROP NOT NULL;

-- Backfill auth fields from AppUser relation
UPDATE "Client" c
SET
  "email" = LOWER(u."email"),
  "passwordHash" = u."passwordHash"
FROM "AppUser" u
WHERE u."clientId" = c."id";

-- Fallback for legacy clients without linked AppUser
UPDATE "Client"
SET "email" = LOWER(CONCAT('client+', "id", '@local.invalid'))
WHERE "email" IS NULL OR BTRIM("email") = '';

UPDATE "Client"
SET "passwordHash" = 'DISABLED'
WHERE "passwordHash" IS NULL OR BTRIM("passwordHash") = '';

ALTER TABLE "Client"
  ALTER COLUMN "email" SET NOT NULL,
  ALTER COLUMN "passwordHash" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Client_email_key" ON "Client"("email");
CREATE INDEX "Client_role_isActive_idx" ON "Client"("role", "isActive");
CREATE INDEX "Client_email_idx" ON "Client"("email");

-- DropTable
DROP TABLE "AppUser";

