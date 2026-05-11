import { env } from "@/config/env";
import { parseProcessIntervalMinutes } from "@/jobs/runProcessingCycle";
import { ClientRepository } from "@/repositories/client.repository";
import { GoogleDriveService } from "@/services/googleDrive.service";
import { SchedulerControlService } from "@/services/schedulerControl.service";
import { getPrismaClient } from "@/lib/prisma";
import { schedulerLog } from "@/lib/logger";
import {
  resolveGoogleConfig,
  resolveSheetName,
  resolveFolders,
  validateClientProcessingConfig,
} from "@/lib/clientProcessingConfig";

const clientRepository = new ClientRepository();
const controlService = new SchedulerControlService();
const globalMinutes = parseProcessIntervalMinutes(env.PROCESS_INTERVAL_MINUTES);
const globalIntervalMs = globalMinutes * 60 * 1000;

let localRunning = false;
const lastRunByClient = new Map<string, number>();

const runOnce = async (): Promise<void> => {
  if (localRunning) {
    schedulerLog.skippedBusy();
    return;
  }

  localRunning = true;

  try {
    const clients = await clientRepository.listActiveClients();
    if (clients.length === 0) {
      schedulerLog.cycleEmpty();
      return;
    }

    schedulerLog.cycleStart(clients.length);

    const now = Date.now();
    let totalFound = 0;
    let totalQueued = 0;
    let totalSkipped = 0;

    for (const client of clients) {
      const clientInterval = (client.intervalMinutes > 0 ? client.intervalMinutes : globalMinutes) * 60 * 1000;
      const lastRun = lastRunByClient.get(client.id) ?? 0;
      if (lastRun > 0 && now - lastRun < clientInterval) {
        continue;
      }
      try {
        const prisma = getPrismaClient();
        const clientMinutes = client.intervalMinutes > 0 ? client.intervalMinutes : globalMinutes;
        await controlService.touchHeartbeat(clientMinutes, client.id);
        const state = await controlService.getState(clientMinutes, client.id);

        if (!state.enabled) {
          schedulerLog.clientPaused(client.id, client.name);
          continue;
        }

        schedulerLog.clientScanning(client.id, client.name);

        const sheetName = resolveSheetName(client);
        const googleConfig = resolveGoogleConfig(client);
        const folders = resolveFolders(client);
        validateClientProcessingConfig(client, sheetName, googleConfig);

        const driveService = new GoogleDriveService(googleConfig);
        const files = await driveService.listPendingPdfFiles(folders.pending);

        if (files.length === 0) {
          schedulerLog.clientNoPdfs(client.id, client.name);
          continue;
        }

        totalFound += files.length;

        let created = 0;
        for (const file of files) {
          const existingInvoice = await prisma.invoice.findFirst({
            where: { clientId: client.id, driveFileId: file.id },
            select: { id: true },
          });
          if (existingInvoice) {
            continue;
          }

          const existingJob = await prisma.processingJob.findFirst({
            where: {
              clientId: client.id,
              driveFileId: file.id,
              status: { in: ["PENDING", "PROCESSING"] },
            },
            select: { id: true },
          });
          if (existingJob) {
            totalSkipped += 1;
            continue;
          }

          await prisma.processingJob.create({
            data: {
              clientId: client.id,
              driveFileId: file.id,
              driveFileName: file.name,
              status: "PENDING",
            },
          });

          created += 1;
          totalQueued += 1;

          if (created >= client.batchSize) {
            schedulerLog.batchLimitReached(client.id, client.name, created, files.length);
            break;
          }
        }

        if (created > 0) {
          schedulerLog.jobsQueued(created, client.id, client.name, files.length, client.batchSize);
        }

        lastRunByClient.set(client.id, now);
      } catch (error) {
        schedulerLog.clientError(
          client.id,
          client.name,
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    }

    if (totalFound >= 1) {
      schedulerLog.cycleSummary({ totalFound, totalQueued, totalSkipped });
    }

    schedulerLog.cycleEnd();
  } catch (error) {
    schedulerLog.fatalError(error instanceof Error ? error.message : "Unknown error");
  } finally {
    localRunning = false;
  }
};

schedulerLog.starting(globalMinutes);

void runOnce();
setInterval(runOnce, globalIntervalMs);
