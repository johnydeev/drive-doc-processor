import { env } from "@/config/env";
import { parseProcessIntervalMinutes } from "@/jobs/runProcessingCycle";
import { processSingleDriveFileJob } from "@/jobs/processPendingDocuments.job";
import { getPrismaClient } from "@/lib/prisma";
import { workerLog } from "@/lib/logger";
import {
  resolveAiConfig,
  resolveGoogleConfig,
  resolveMapping,
  resolveSheetName,
  resolveFolders,
  validateClientProcessingConfig,
} from "@/lib/clientProcessingConfig";
import { ProcessingPersistenceService } from "@/services/processingPersistence.service";
import type { ClientDriveFolders, ProcessingClient } from "@/types/client.types";
import type { ProcessJobSummary } from "@/types/process.types";

const POLL_INTERVAL_MS = 2000;
const intervalMinutes = parseProcessIntervalMinutes(env.PROCESS_INTERVAL_MINUTES);
const persistence = new ProcessingPersistenceService();

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function mapClient(row: {
  id: string;
  name: string;
  isActive: boolean;
  batchSize: number;
  intervalMinutes: number;
  driveFoldersJson: unknown;
  googleConfigJson: unknown;
  extractionConfigJson: unknown;
}): ProcessingClient {
  return {
    id: row.id,
    name: row.name,
    isActive: row.isActive,
    batchSize: row.batchSize,
    intervalMinutes: row.intervalMinutes,
    driveFoldersJson: (row.driveFoldersJson as ClientDriveFolders | null | undefined) ?? null,
    googleConfigJson: (row.googleConfigJson as ProcessingClient["googleConfigJson"]) ?? null,
    extractionConfigJson:
      (row.extractionConfigJson as ProcessingClient["extractionConfigJson"]) ?? null,
  };
}

async function claimNextJob() {
  const prisma = getPrismaClient();
  const job = await prisma.processingJob.findFirst({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
  });

  if (!job) return null;

  const now = new Date();
  const updated = await prisma.processingJob.updateMany({
    where: { id: job.id, status: "PENDING" },
    data: { status: "PROCESSING", startedAt: now },
  });

  if (updated.count === 0) return null;

  return { ...job, status: "PROCESSING", startedAt: now };
}

async function finalizeJob(
  jobId: string,
  fileName: string | null,
  attempts: number,
  maxAttempts: number,
  startedAt: Date | null,
  success: boolean,
  errorMessage?: string
): Promise<void> {
  const prisma = getPrismaClient();
  const now = new Date();
  const durationMs = startedAt ? now.getTime() - startedAt.getTime() : 0;

  if (success) {
    await prisma.processingJob.update({
      where: { id: jobId },
      data: { status: "COMPLETED", finishedAt: now, errorMessage: null },
    });
    workerLog.jobCompleted(jobId, fileName, durationMs);
    return;
  }

  const nextAttempts = attempts + 1;
  const shouldFail = nextAttempts >= maxAttempts;

  await prisma.processingJob.update({
    where: { id: jobId },
    data: {
      status: shouldFail ? "FAILED" : "PENDING",
      attempts: nextAttempts,
      errorMessage: errorMessage ?? "Unknown error",
      finishedAt: shouldFail ? now : null,
      startedAt: shouldFail ? startedAt : null,
    },
  });

  workerLog.jobFailed(jobId, fileName, errorMessage ?? "Unknown error", nextAttempts, maxAttempts);

  if (shouldFail) {
    workerLog.jobPermanentFailure(jobId, fileName);
  } else {
    workerLog.jobRetry(jobId, nextAttempts + 1, maxAttempts);
  }
}

async function handleJob(job: {
  id: string;
  clientId: string;
  driveFileId: string;
  driveFileName: string | null;
  attempts: number;
  maxAttempts: number;
  startedAt: Date | null;
}): Promise<void> {
  const prisma = getPrismaClient();

  const clientRow = await prisma.client.findUnique({
    where: { id: job.clientId },
    select: {
      id: true,
      name: true,
      isActive: true,
      batchSize: true,
      intervalMinutes: true,
      driveFoldersJson: true,
      googleConfigJson: true,
      extractionConfigJson: true,
    },
  });

  if (!clientRow) {
    workerLog.clientNotFound(job.id, job.clientId);
    await finalizeJob(job.id, job.driveFileName, job.attempts, job.maxAttempts, job.startedAt, false, "Client not found");
    return;
  }

  const client = mapClient(clientRow);

  if (!client.isActive) {
    workerLog.clientInactive(job.id, client.name);
    await finalizeJob(job.id, job.driveFileName, job.attempts, job.maxAttempts, job.startedAt, false, "Client inactive");
    return;
  }

  workerLog.jobClaimed(job.id, job.driveFileId, job.driveFileName, client.name);

  let errorMessage: string | undefined;
  let summary: ProcessJobSummary | null = null;

  try {
    const sheetName = resolveSheetName(client);
    const mapping = resolveMapping(client);
    const googleConfig = resolveGoogleConfig(client);
    const folders = resolveFolders(client);
    validateClientProcessingConfig(client, sheetName, googleConfig);

    summary = await processSingleDriveFileJob(
      {
        clientId: client.id,
        clientName: client.name,
        sheetName,
        mapping,
        drivePendingFolderId: folders.pending,
        driveScannedFolderId: folders.scanned,
        driveUnassignedFolderId: folders.unassigned,
        driveFailedFolderId: folders.failed,
        driveProcessingFolderId: folders.processing,
        googleConfig,
        aiConfig: resolveAiConfig(client),
      },
      {
        id: job.driveFileId,
        name: job.driveFileName ?? job.driveFileId,
      }
    );

    if (summary.failed > 0) {
      errorMessage = summary.errors[0]?.error ?? "Job failed";
    }
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : "Unknown error";
  }

  const success = summary !== null && summary.failed === 0;
  await finalizeJob(job.id, job.driveFileName, job.attempts, job.maxAttempts, job.startedAt, success, errorMessage);

  if (summary) {
    const now = new Date();
    await persistence.recordClientRun({
      clientId: client.id,
      trigger: "schedule",
      intervalMinutes,
      enabled: true,
      startedAt: job.startedAt ?? now,
      endedAt: now,
      summary,
      errorMessage: success ? undefined : errorMessage,
    });
  }
}

async function runWorker(): Promise<void> {
  workerLog.starting();

  while (true) {
    const job = await claimNextJob();
    if (!job) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    try {
      await handleJob(job);
    } catch (error) {
      workerLog.unhandledError(
        job.id,
        error instanceof Error ? error.message : "Unknown error"
      );
    }
  }
}

void runWorker();
