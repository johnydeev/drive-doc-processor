import { env } from "@/config/env";
import { createEmptyTokenUsageSummary } from "@/lib/createEmptyTokenUsageSummary";
import { cycleLog } from "@/lib/logger";
import { ClientRepository } from "@/repositories/client.repository";
import { processPendingDocumentsJob } from "@/jobs/processPendingDocuments.job";
import { SchedulerControlService } from "@/services/schedulerControl.service";
import { ProcessingPersistenceService } from "@/services/processingPersistence.service";
import { ProcessJobSummary } from "@/types/process.types";
import { SchedulerTrigger } from "@/types/scheduler.types";
import {
  resolveAiConfig,
  resolveGoogleConfig,
  resolveMapping,
  resolveSheetName,
  resolveFolders,
  validateClientProcessingConfig,
} from "@/lib/clientProcessingConfig";

export interface RunProcessingCycleOptions {
  ignoreEnabled?: boolean;
  clientId?: string;
}

export function parseProcessIntervalMinutes(value: string): number {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error("PROCESS_INTERVAL_MINUTES must be a positive number");
  }

  return minutes;
}

export async function runProcessingCycle(
  trigger: SchedulerTrigger,
  options?: RunProcessingCycleOptions
): Promise<ProcessJobSummary> {
  const intervalMinutes = parseProcessIntervalMinutes(env.PROCESS_INTERVAL_MINUTES);
  const controlService = new SchedulerControlService();
  const current = await controlService.getState(intervalMinutes, options?.clientId);

  if (!options?.ignoreEnabled && !current.enabled) {
    throw new Error("Scheduler is paused (enabled=false)");
  }

  const started = await controlService.tryStartRun(trigger, intervalMinutes, options?.clientId);
  if (!started) {
    throw new Error("Another processing run is already in progress");
  }

  const clientRepository = new ClientRepository();
  const persistenceService = new ProcessingPersistenceService();
  const allClients = await clientRepository.listActiveClients();
  const clients = options?.clientId
    ? allClients.filter((client) => client.id === options.clientId)
    : allClients;

  if (options?.clientId && clients.length === 0) {
    throw new Error(`Client not found or inactive: ${options.clientId}`);
  }

  cycleLog.start(trigger, clients.length, intervalMinutes, options?.clientId);

  const aggregateSummary = createAggregateSummary();

  try {
    for (const client of clients) {
      const startedAt = new Date();
      const sheetName = resolveSheetName(client);
      const mapping = resolveMapping(client);
      const googleConfig = resolveGoogleConfig(client);
      const folders = resolveFolders(client);

      try {
        validateClientProcessingConfig(client, sheetName, googleConfig);
        cycleLog.clientStart(client.id, client.name);

        const clientSummary = await processPendingDocumentsJob({
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
          debugMode: !!(client.extractionConfigJson as Record<string, unknown> | null)?.debugMode,
        });

        addSummary(aggregateSummary, clientSummary);
        aggregateSummary.clientSummaries?.push(clientSummary);

        await persistenceService.recordClientRun({
          clientId: client.id,
          trigger,
          intervalMinutes,
          enabled: current.enabled,
          startedAt,
          endedAt: new Date(),
          summary: clientSummary,
        });

        cycleLog.clientDone(client.id, clientSummary.processed, clientSummary.unassigned, clientSummary.failed);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        cycleLog.clientFailed(client.id, message);

        const failedClientSummary: ProcessJobSummary = {
          clientId: client.id,
          clientName: client.name,
          totalFound: 0,
          processed: 0,
          skipped: 0,
          failed: 1,
          unassigned: 0,
          duplicatesDetected: 0,
          errors: [{ fileId: `client:${client.id}`, fileName: client.name, error: message }],
          tokenUsage: createEmptyTokenUsageSummary(),
        };

        addSummary(aggregateSummary, failedClientSummary);
        aggregateSummary.clientSummaries?.push(failedClientSummary);

        await persistenceService.recordClientRun({
          clientId: client.id,
          trigger,
          intervalMinutes,
          enabled: current.enabled,
          startedAt,
          endedAt: new Date(),
          summary: failedClientSummary,
          errorMessage: message,
        });
      }
    }

    await controlService.completeRun(aggregateSummary, intervalMinutes, options?.clientId);
    cycleLog.aggregateSummary({
      totalFound: aggregateSummary.totalFound,
      processed: aggregateSummary.processed,
      unassigned: aggregateSummary.unassigned,
      failed: aggregateSummary.failed,
      duplicatesDetected: aggregateSummary.duplicatesDetected,
    });
    return aggregateSummary;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    await controlService.failRun(message, intervalMinutes, options?.clientId);
    throw error;
  }
}

function createAggregateSummary(): ProcessJobSummary {
  return {
    totalFound: 0,
    processed: 0,
    skipped: 0,
    failed: 0,
    unassigned: 0,
    duplicatesDetected: 0,
    errors: [],
    tokenUsage: createEmptyTokenUsageSummary(),
    clientSummaries: [],
  };
}

function addSummary(target: ProcessJobSummary, incoming: ProcessJobSummary): void {
  target.totalFound += incoming.totalFound;
  target.processed += incoming.processed;
  target.skipped += incoming.skipped;
  target.failed += incoming.failed;
  target.unassigned += incoming.unassigned;
  target.duplicatesDetected += incoming.duplicatesDetected;
  target.errors.push(...incoming.errors);

  target.tokenUsage.inputTokens += incoming.tokenUsage.inputTokens;
  target.tokenUsage.outputTokens += incoming.tokenUsage.outputTokens;
  target.tokenUsage.totalTokens += incoming.tokenUsage.totalTokens;

  for (const [provider, bd] of Object.entries(incoming.tokenUsage.byProvider)) {
    const existing = target.tokenUsage.byProvider[provider] ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    target.tokenUsage.byProvider[provider] = {
      inputTokens: existing.inputTokens + bd.inputTokens,
      outputTokens: existing.outputTokens + bd.outputTokens,
      totalTokens: existing.totalTokens + bd.totalTokens,
    };
  }

  for (const [model, bd] of Object.entries(incoming.tokenUsage.byModel)) {
    const existing = target.tokenUsage.byModel[model] ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    target.tokenUsage.byModel[model] = {
      inputTokens: existing.inputTokens + bd.inputTokens,
      outputTokens: existing.outputTokens + bd.outputTokens,
      totalTokens: existing.totalTokens + bd.totalTokens,
    };
  }
}
