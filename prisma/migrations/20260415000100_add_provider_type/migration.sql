-- CreateEnum
CREATE TYPE "ProviderType" AS ENUM ('PROVEEDOR', 'EMPLEADO');

-- AlterTable
ALTER TABLE "Provider" ADD COLUMN "providerType" "ProviderType" NOT NULL DEFAULT 'PROVEEDOR';
