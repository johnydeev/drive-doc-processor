DROP INDEX IF EXISTS "uq_invoice_business_key";

ALTER TABLE "Invoice" DROP COLUMN IF EXISTS "detailNorm";
ALTER TABLE "Invoice" DROP COLUMN IF EXISTS "consortiumNorm";

CREATE UNIQUE INDEX "uq_invoice_business_key"
ON "Invoice"(
  "clientId",
  "boletaNumberNorm",
  "providerTaxIdNorm",
  "dueDateNorm",
  "amountNorm"
);
