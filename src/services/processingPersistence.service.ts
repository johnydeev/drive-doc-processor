import { Prisma } from "@prisma/client";
import { getPrismaClient } from "@/lib/prisma";
import { ProcessJobSummary } from "@/types/process.types";
import { SchedulerTrigger } from "@/types/scheduler.types";

interface RecordClientRunInput {
  clientId: string;
  trigger: SchedulerTrigger;
  intervalMinutes: number;
  enabled: boolean;
  startedAt: Date;
  endedAt: Date;
  summary: ProcessJobSummary | null;
  errorMessage?: string;
}

export class ProcessingPersistenceService {
  async recordClientRun(input: RecordClientRunInput): Promise<void> {
    const prisma = getPrismaClient();
    const durationMs = Math.max(input.endedAt.getTime() - input.startedAt.getTime(), 0);
    const status = this.resolveStatus(input.summary, input.errorMessage);

    await prisma.processingLog.create({
      data: {
        clientId: input.clientId,
        trigger: input.trigger,
        status,
        startedAt: input.startedAt,
        endedAt: input.endedAt,
        durationMs,
        summaryJson: input.summary as unknown as Prisma.JsonObject,
        errorMessage: input.errorMessage,
      },
    });

    await prisma.schedulerState.upsert({
      where: { clientId: input.clientId },
      create: {
        clientId: input.clientId,
        enabled: input.enabled,
        isRunning: false,
        intervalMinutes: input.intervalMinutes,
        lastTrigger: input.trigger,
        lastRunStartedAt: input.startedAt,
        lastRunEndedAt: input.endedAt,
        lastHeartbeatAt: input.endedAt,
        lastError: input.errorMessage ?? null,
        lastSummaryJson: (input.summary ?? null) as unknown as Prisma.JsonObject,
        totalRuns: 1,
        totalFound: input.summary?.totalFound ?? 0,
        totalProcessed: input.summary?.processed ?? 0,
        totalSkipped: input.summary?.skipped ?? 0,
        totalFailed: input.summary?.failed ?? 0,
        totalDuplicates: input.summary?.duplicatesDetected ?? 0,
        totalInputTokens: input.summary?.tokenUsage.inputTokens ?? 0,
        totalOutputTokens: input.summary?.tokenUsage.outputTokens ?? 0,
        totalTokens: input.summary?.tokenUsage.totalTokens ?? 0,
      },
      update: {
        enabled: input.enabled,
        isRunning: false,
        intervalMinutes: input.intervalMinutes,
        lastTrigger: input.trigger,
        lastRunStartedAt: input.startedAt,
        lastRunEndedAt: input.endedAt,
        lastHeartbeatAt: input.endedAt,
        lastError: input.errorMessage ?? null,
        lastSummaryJson: (input.summary ?? null) as unknown as Prisma.JsonObject,
        totalRuns: { increment: 1 },
        totalFound: { increment: input.summary?.totalFound ?? 0 },
        totalProcessed: { increment: input.summary?.processed ?? 0 },
        totalSkipped: { increment: input.summary?.skipped ?? 0 },
        totalFailed: { increment: input.summary?.failed ?? 0 },
        totalDuplicates: { increment: input.summary?.duplicatesDetected ?? 0 },
        totalInputTokens: { increment: input.summary?.tokenUsage.inputTokens ?? 0 },
        totalOutputTokens: { increment: input.summary?.tokenUsage.outputTokens ?? 0 },
        totalTokens: { increment: input.summary?.tokenUsage.totalTokens ?? 0 },
      },
    });

    if (!input.summary) {
      return;
    }

    const tokenRows: Prisma.TokenUsageCreateManyInput[] = [];

    if (input.summary.tokenUsage.totalTokens > 0) {
      tokenRows.push({
        clientId: input.clientId,
        provider: "aggregate",
        model: null,
        inputTokens: input.summary.tokenUsage.inputTokens,
        outputTokens: input.summary.tokenUsage.outputTokens,
        totalTokens: input.summary.tokenUsage.totalTokens,
        runAt: input.endedAt,
        metaJson: {
          trigger: input.trigger,
        },
      });
    }

    for (const [provider, totalTokens] of Object.entries(input.summary.tokenUsage.byProvider)) {
      tokenRows.push({
        clientId: input.clientId,
        provider,
        model: null,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens,
        runAt: input.endedAt,
        metaJson: {
          trigger: input.trigger,
        },
      });
    }

    for (const [model, totalTokens] of Object.entries(input.summary.tokenUsage.byModel)) {
      tokenRows.push({
        clientId: input.clientId,
        provider: inferProviderFromModel(model),
        model,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens,
        runAt: input.endedAt,
        metaJson: {
          trigger: input.trigger,
        },
      });
    }

    if (tokenRows.length > 0) {
      await prisma.tokenUsage.createMany({
        data: tokenRows,
      });
    }
  }

  private resolveStatus(summary: ProcessJobSummary | null, errorMessage?: string): string {
    if (errorMessage) {
      return "failed";
    }

    if (!summary) {
      return "failed";
    }

    if (summary.failed > 0 && summary.processed > 0) {
      return "partial";
    }

    if (summary.failed > 0 && summary.processed === 0) {
      return "failed";
    }

    return "success";
  }
}

function inferProviderFromModel(model: string): string {
  const normalized = model.toLowerCase();
  if (normalized.includes("gemini")) {
    return "gemini";
  }

  if (normalized.includes("gpt") || normalized.includes("o1") || normalized.includes("o3")) {
    return "openai";
  }

  return "unknown";
}
