-- Drop old business key unique index including detailNorm
DROP INDEX IF EXISTS "uq_invoice_business_key";

-- Recreate business key unique index without detailNorm
CREATE UNIQUE INDEX "uq_invoice_business_key"
ON "Invoice"(
  "clientId",
  "boletaNumberNorm",
  "providerTaxIdNorm",
  "consortiumNorm",
  "dueDateNorm",
  "amountNorm"
);
