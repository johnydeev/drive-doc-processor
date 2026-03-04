import { env } from "@/config/env";
import { ClientRepository } from "@/repositories/client.repository";
import { processPendingDocumentsJob } from "@/jobs/processPendingDocuments.job";
import { SchedulerControlService } from "@/services/schedulerControl.service";
import { ProcessingPersistenceService } from "@/services/processingPersistence.service";
import { ProcessJobSummary } from "@/types/process.types";
import { SchedulerTrigger } from "@/types/scheduler.types";
import { ClientGoogleConfig, ProcessingClient } from "@/types/client.types";
import { SheetsRowMapping } from "@/services/googleSheets.service";

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

  console.log(
    `[run-cycle] trigger=${trigger} clients=${clients.length} intervalMinutes=${intervalMinutes} enabled=${current.enabled} targetClient=${options?.clientId ?? "ALL"}`
  );

  const aggregateSummary = createAggregateSummary();

  try {
    for (const client of clients) {
      const startedAt = new Date();
      const sheetName = resolveSheetName(client);
      const mapping = resolveMapping(client);
      const googleConfig = resolveGoogleConfig(client);

      try {
        validateClientProcessingConfig(client, sheetName, googleConfig);
        console.log(`[run-cycle] client-start clientId=${client.id} name="${client.name}"`);
        const clientSummary = await processPendingDocumentsJob({
          clientId: client.id,
          clientName: client.name,
          sheetName,
          mapping,
          drivePendingFolderId: client.driveFolderPending,
          driveScannedFolderId: client.driveFolderProcessed,
          googleConfig,
          aiConfig: resolveAiConfig(client),
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
        console.log(
          `[run-cycle] client-done clientId=${client.id} processed=${clientSummary.processed} failed=${clientSummary.failed}`
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        console.error(`[run-cycle] client-failed clientId=${client.id} error=${message}`);

        const failedClientSummary: ProcessJobSummary = {
          clientId: client.id,
          clientName: client.name,
          totalFound: 0,
          processed: 0,
          skipped: 0,
          failed: 1,
          duplicatesDetected: 0,
          errors: [
            {
              fileId: `client:${client.id}`,
              fileName: client.name,
              error: message,
            },
          ],
          tokenUsage: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            byProvider: {},
            byModel: {},
          },
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
    console.log(
      `[run-cycle] aggregate totalFound=${aggregateSummary.totalFound} processed=${aggregateSummary.processed} failed=${aggregateSummary.failed} duplicates=${aggregateSummary.duplicatesDetected}`
    );
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
    duplicatesDetected: 0,
    errors: [],
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      byProvider: {},
      byModel: {},
    },
    clientSummaries: [],
  };
}

function addSummary(target: ProcessJobSummary, incoming: ProcessJobSummary): void {
  target.totalFound += incoming.totalFound;
  target.processed += incoming.processed;
  target.skipped += incoming.skipped;
  target.failed += incoming.failed;
  target.duplicatesDetected += incoming.duplicatesDetected;
  target.errors.push(...incoming.errors);

  target.tokenUsage.inputTokens += incoming.tokenUsage.inputTokens;
  target.tokenUsage.outputTokens += incoming.tokenUsage.outputTokens;
  target.tokenUsage.totalTokens += incoming.tokenUsage.totalTokens;

  for (const [provider, total] of Object.entries(incoming.tokenUsage.byProvider)) {
    target.tokenUsage.byProvider[provider] = (target.tokenUsage.byProvider[provider] ?? 0) + total;
  }

  for (const [model, total] of Object.entries(incoming.tokenUsage.byModel)) {
    target.tokenUsage.byModel[model] = (target.tokenUsage.byModel[model] ?? 0) + total;
  }
}

function resolveSheetName(client: ProcessingClient): string {
  const fromConfig = client.extractionConfigJson?.sheetName;
  if (typeof fromConfig === "string" && fromConfig.trim().length > 0) {
    return fromConfig.trim();
  }

  return env.GOOGLE_SHEETS_SHEET_NAME;
}

function resolveMapping(client: ProcessingClient): SheetsRowMapping | undefined {
  const raw = client.extractionConfigJson?.columnMapping;
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const requiredKeys: Array<keyof SheetsRowMapping> = [
    "boletaNumber",
    "provider",
    "consortium",
    "providerTaxId",
    "detail",
    "observation",
    "dueDate",
    "amount",
    "alias",
    "sourceFileUrl",
    "isDuplicate",
  ];

  const parsed = raw as Record<string, unknown>;
  for (const key of requiredKeys) {
    if (typeof parsed[key] !== "string" || parsed[key].trim().length === 0) {
      return undefined;
    }
  }

  return parsed as unknown as SheetsRowMapping;
}

function resolveGoogleConfig(client: ProcessingClient): ClientGoogleConfig | null {
  const raw = client.googleConfigJson;
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const projectId = asRequiredString(raw.projectId);
  const clientEmail = asRequiredString(raw.clientEmail);
  const privateKey = asRequiredString(raw.privateKey);
  const sheetsId = asRequiredString(raw.sheetsId);

  if (!projectId || !clientEmail || !privateKey || !sheetsId) {
    return null;
  }

  return {
    projectId,
    clientEmail,
    privateKey,
    sheetsId,
  };
}

function resolveAiConfig(client: ProcessingClient): {
  geminiApiKey?: string;
  geminiModel?: string;
  openaiApiKey?: string;
  openaiModel?: string;
} | null {
  const raw = client.extractionConfigJson;
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const geminiApiKey = asOptionalString(raw.geminiApiKey);
  const geminiModel = asOptionalString(raw.geminiModel);
  const openaiApiKey = asOptionalString(raw.openaiApiKey);
  const openaiModel = asOptionalString(raw.openaiModel);

  if (!geminiApiKey && !openaiApiKey && !geminiModel && !openaiModel) {
    return null;
  }

  return {
    geminiApiKey,
    geminiModel,
    openaiApiKey,
    openaiModel,
  };
}

function asRequiredString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function validateClientProcessingConfig(
  client: ProcessingClient,
  sheetName: string,
  googleConfig: ClientGoogleConfig | null
): void {
  const pendingFolderId = client.driveFolderPending.trim();
  const scannedFolderId = client.driveFolderProcessed.trim();

  if (!pendingFolderId) {
    throw new Error("Missing required client config: driveFolderPending");
  }

  if (!scannedFolderId) {
    throw new Error("Missing required client config: driveFolderProcessed");
  }

  if (pendingFolderId === scannedFolderId) {
    throw new Error("Invalid client config: pending and scanned folders must be different");
  }

  if (!sheetName.trim()) {
    throw new Error("Missing required client config: sheetName");
  }

  if (!googleConfig) {
    throw new Error("Missing required client config: google credentials (projectId/clientEmail/privateKey/sheetsId)");
  }
}
