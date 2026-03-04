-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "driveFolderPending" TEXT NOT NULL,
    "driveFolderProcessed" TEXT NOT NULL,
    "googleConfigJson" JSONB,
    "extractionConfigJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "documentHash" TEXT NOT NULL,
    "boletaNumber" TEXT,
    "provider" TEXT,
    "consortium" TEXT,
    "providerTaxId" TEXT,
    "detail" TEXT,
    "observation" TEXT,
    "dueDate" TIMESTAMP(3),
    "amount" DECIMAL(14,2),
    "alias" TEXT,
    "driveFileId" TEXT,
    "sourceFileUrl" TEXT,
    "isDuplicate" BOOLEAN NOT NULL DEFAULT false,
    "boletaNumberNorm" TEXT NOT NULL DEFAULT '',
    "providerTaxIdNorm" TEXT NOT NULL DEFAULT '',
    "consortiumNorm" TEXT NOT NULL DEFAULT '',
    "dueDateNorm" TEXT NOT NULL DEFAULT '',
    "amountNorm" TEXT NOT NULL DEFAULT '',
    "detailNorm" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessingLog" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "summaryJson" JSONB,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessingLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SchedulerState" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "isRunning" BOOLEAN NOT NULL DEFAULT false,
    "intervalMinutes" INTEGER NOT NULL DEFAULT 5,
    "lastTrigger" TEXT,
    "lastRunStartedAt" TIMESTAMP(3),
    "lastRunEndedAt" TIMESTAMP(3),
    "lastHeartbeatAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastSummaryJson" JSONB,
    "totalRuns" INTEGER NOT NULL DEFAULT 0,
    "totalFound" INTEGER NOT NULL DEFAULT 0,
    "totalProcessed" INTEGER NOT NULL DEFAULT 0,
    "totalSkipped" INTEGER NOT NULL DEFAULT 0,
    "totalFailed" INTEGER NOT NULL DEFAULT 0,
    "totalDuplicates" INTEGER NOT NULL DEFAULT 0,
    "totalInputTokens" INTEGER NOT NULL DEFAULT 0,
    "totalOutputTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "quotaOpenAiStatus" TEXT NOT NULL DEFAULT 'unknown',
    "quotaOpenAiNote" TEXT,
    "quotaGeminiStatus" TEXT NOT NULL DEFAULT 'unknown',
    "quotaGeminiNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SchedulerState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TokenUsage" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metaJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TokenUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Client_isActive_idx" ON "Client"("isActive");

-- CreateIndex
CREATE INDEX "Invoice_clientId_createdAt_idx" ON "Invoice"("clientId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "uq_invoice_document_hash" ON "Invoice"("clientId", "documentHash");

-- CreateIndex
CREATE UNIQUE INDEX "uq_invoice_business_key" ON "Invoice"("clientId", "boletaNumberNorm", "providerTaxIdNorm", "consortiumNorm", "dueDateNorm", "amountNorm", "detailNorm");

-- CreateIndex
CREATE INDEX "ProcessingLog_clientId_startedAt_idx" ON "ProcessingLog"("clientId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SchedulerState_clientId_key" ON "SchedulerState"("clientId");

-- CreateIndex
CREATE INDEX "TokenUsage_clientId_runAt_idx" ON "TokenUsage"("clientId", "runAt");

-- CreateIndex
CREATE INDEX "TokenUsage_provider_idx" ON "TokenUsage"("provider");

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessingLog" ADD CONSTRAINT "ProcessingLog_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchedulerState" ADD CONSTRAINT "SchedulerState_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TokenUsage" ADD CONSTRAINT "TokenUsage_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

