-- CreateIndex
CREATE UNIQUE INDEX "Provider_clientId_canonicalName_key" ON "Provider"("clientId", "canonicalName");
