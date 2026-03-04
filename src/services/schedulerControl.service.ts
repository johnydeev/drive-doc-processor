import { Prisma, SchedulerState } from "@prisma/client";
import {
  type TokenUsageSummary,
} from "@/types/aiUsage.types";
import { createEmptyTokenUsageSummary } from "@/types/createEmptyTokenUsageSummary";
import { ProcessJobErrorEntry, ProcessJobSummary } from "@/types/process.types";
import {
  ProviderQuotaState,
  QuotaStatus,
  SchedulerRuntimeState,
  SchedulerTrigger,
} from "@/types/scheduler.types";
import { getPrismaClient } from "@/lib/prisma";

const DEFAULT_QUOTA_NOTE = "Sin datos de cuota aun.";

export class SchedulerControlService {
  async getState(intervalMinutes: number, clientId?: string): Promise<SchedulerRuntimeState> {
    const { activeClientIds, states } = await this.ensureClientStates(intervalMinutes, clientId);
    const providerBreakdown = await this.loadTokenBreakdown(activeClientIds);
    return this.toRuntimeState(states, intervalMinutes, providerBreakdown);
  }

  async setEnabled(
    enabled: boolean,
    intervalMinutes: number,
    clientId?: string
  ): Promise<SchedulerRuntimeState> {
    const { activeClientIds } = await this.ensureClientStates(intervalMinutes, clientId);

    if (activeClientIds.length > 0) {
      const prisma = getPrismaClient();
      await prisma.schedulerState.updateMany({
        where: { clientId: { in: activeClientIds } },
        data: {
          enabled,
          intervalMinutes,
          updatedAt: new Date(),
        },
      });
    }

    return this.getState(intervalMinutes, clientId);
  }

  async touchHeartbeat(intervalMinutes: number, clientId?: string): Promise<SchedulerRuntimeState> {
    const { activeClientIds } = await this.ensureClientStates(intervalMinutes, clientId);

    if (activeClientIds.length > 0) {
      const now = new Date();
      const prisma = getPrismaClient();
      await prisma.schedulerState.updateMany({
        where: { clientId: { in: activeClientIds } },
        data: {
          lastHeartbeatAt: now,
          intervalMinutes,
          updatedAt: now,
        },
      });
    }

    return this.getState(intervalMinutes, clientId);
  }

  async tryStartRun(
    trigger: SchedulerTrigger,
    intervalMinutes: number,
    clientId?: string
  ): Promise<boolean> {
    const { activeClientIds, states } = await this.ensureClientStates(intervalMinutes, clientId);

    if (states.some((state) => state.isRunning)) {
      return false;
    }

    if (activeClientIds.length === 0) {
      return true;
    }

    const now = new Date();
    const prisma = getPrismaClient();

    await prisma.schedulerState.updateMany({
      where: { clientId: { in: activeClientIds } },
      data: {
        isRunning: true,
        lastTrigger: trigger,
        lastRunStartedAt: now,
        lastError: null,
        intervalMinutes,
        updatedAt: now,
      },
    });

    return true;
  }

  async completeRun(
    summary: ProcessJobSummary,
    intervalMinutes: number,
    clientId?: string
  ): Promise<SchedulerRuntimeState> {
    const { activeClientIds } = await this.ensureClientStates(intervalMinutes, clientId);

    if (activeClientIds.length > 0) {
      const now = new Date();
      const quotaPatch = this.quotaPatchFromSummary(summary, now);
      const prisma = getPrismaClient();

      await prisma.schedulerState.updateMany({
        where: { clientId: { in: activeClientIds } },
        data: {
          isRunning: false,
          lastRunEndedAt: now,
          lastHeartbeatAt: now,
          lastError: null,
          intervalMinutes,
          updatedAt: now,
          ...quotaPatch,
        },
      });
    }

    return this.getState(intervalMinutes, clientId);
  }

  async failRun(
    errorMessage: string,
    intervalMinutes: number,
    clientId?: string
  ): Promise<SchedulerRuntimeState> {
    const { activeClientIds } = await this.ensureClientStates(intervalMinutes, clientId);

    if (activeClientIds.length > 0) {
      const now = new Date();
      const quotaPatch = this.quotaPatchFromError(errorMessage, now);
      const prisma = getPrismaClient();

      await prisma.schedulerState.updateMany({
        where: { clientId: { in: activeClientIds } },
        data: {
          isRunning: false,
          lastRunEndedAt: now,
          lastHeartbeatAt: now,
          lastError: trimError(errorMessage),
          intervalMinutes,
          updatedAt: now,
          ...quotaPatch,
        },
      });
    }

    return this.getState(intervalMinutes, clientId);
  }

  private async ensureClientStates(
    intervalMinutes: number,
    clientId?: string
  ): Promise<{ activeClientIds: string[]; states: SchedulerState[] }> {
    const prisma = getPrismaClient();
    const clients = await prisma.client.findMany({
      where: {
        isActive: true,
        role: "CLIENT",
        ...(clientId ? { id: clientId } : {}),
      },
      select: { id: true },
    });

    const activeClientIds = clients.map((client) => client.id);
    if (activeClientIds.length === 0) {
      return { activeClientIds, states: [] };
    }

    let states = await prisma.schedulerState.findMany({
      where: { clientId: { in: activeClientIds } },
    });

    const existingIds = new Set(states.map((state) => state.clientId));
    const missingClientIds = activeClientIds.filter((id) => !existingIds.has(id));

    if (missingClientIds.length > 0) {
      await prisma.schedulerState.createMany({
        data: missingClientIds.map((id) => ({
          clientId: id,
          enabled: true,
          isRunning: false,
          intervalMinutes,
        })),
      });

      states = await prisma.schedulerState.findMany({
        where: { clientId: { in: activeClientIds } },
      });
    }

    return { activeClientIds, states };
  }

  private async loadTokenBreakdown(clientIds: string[]): Promise<{
    byProvider: Record<string, number>;
    byModel: Record<string, number>;
  }> {
    if (clientIds.length === 0) {
      return {
        byProvider: {},
        byModel: {},
      };
    }

    const prisma = getPrismaClient();

    const [providerRows, modelRows] = await Promise.all([
      prisma.tokenUsage.groupBy({
        by: ["provider"],
        where: {
          clientId: { in: clientIds },
        },
        _sum: {
          totalTokens: true,
        },
      }),
      prisma.tokenUsage.groupBy({
        by: ["model"],
        where: {
          clientId: { in: clientIds },
          model: { not: null },
        },
        _sum: {
          totalTokens: true,
        },
      }),
    ]);

    const byProvider: Record<string, number> = {};
    for (const row of providerRows) {
      byProvider[row.provider] = Number(row._sum.totalTokens ?? 0);
    }

    const byModel: Record<string, number> = {};
    for (const row of modelRows) {
      const model = row.model;
      if (!model) {
        continue;
      }
      byModel[model] = Number(row._sum.totalTokens ?? 0);
    }

    return { byProvider, byModel };
  }

  private toRuntimeState(
    states: SchedulerState[],
    intervalMinutes: number,
    breakdown: { byProvider: Record<string, number>; byModel: Record<string, number> }
  ): SchedulerRuntimeState {
    if (states.length === 0) {
      return createDefaultState(intervalMinutes);
    }

    const totals = {
      runs: 0,
      totalFound: 0,
      processed: 0,
      skipped: 0,
      failed: 0,
      duplicatesDetected: 0,
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        byProvider: breakdown.byProvider,
        byModel: breakdown.byModel,
      } as TokenUsageSummary,
    };

    for (const state of states) {
      totals.runs += state.totalRuns;
      totals.totalFound += state.totalFound;
      totals.processed += state.totalProcessed;
      totals.skipped += state.totalSkipped;
      totals.failed += state.totalFailed;
      totals.duplicatesDetected += state.totalDuplicates;
      totals.tokenUsage.inputTokens += state.totalInputTokens;
      totals.tokenUsage.outputTokens += state.totalOutputTokens;
      totals.tokenUsage.totalTokens += state.totalTokens;
    }

    const latestState = states.reduce((latest, current) => {
      if (!latest) {
        return current;
      }

      return current.updatedAt > latest.updatedAt ? current : latest;
    }, states[0] as SchedulerState);

    return {
      enabled: states.every((state) => state.enabled),
      isRunning: states.some((state) => state.isRunning),
      intervalMinutes,
      lastTrigger: toTrigger(latestState.lastTrigger),
      lastRunStartedAt: maxDate(states.map((state) => state.lastRunStartedAt)),
      lastRunEndedAt: maxDate(states.map((state) => state.lastRunEndedAt)),
      lastHeartbeatAt: maxDate(states.map((state) => state.lastHeartbeatAt)),
      lastError: latestError(states),
      lastSummary: aggregateLastSummary(states),
      totals,
      quota: {
        openai: combineQuota(states, "quotaOpenAiStatus", "quotaOpenAiNote"),
        gemini: combineQuota(states, "quotaGeminiStatus", "quotaGeminiNote"),
      },
      updatedAt: latestState.updatedAt.toISOString(),
    };
  }

  private quotaPatchFromSummary(
    summary: ProcessJobSummary,
    now: Date
  ): Prisma.SchedulerStateUpdateManyMutationInput {
    const patch: Prisma.SchedulerStateUpdateManyMutationInput = {};

    if ((summary.tokenUsage.byProvider.openai ?? 0) > 0) {
      patch.quotaOpenAiStatus = "ok";
      patch.quotaOpenAiNote = "Consumo detectado en la ultima ejecucion.";
    }

    if ((summary.tokenUsage.byProvider.gemini ?? 0) > 0) {
      patch.quotaGeminiStatus = "ok";
      patch.quotaGeminiNote = "Consumo detectado en la ultima ejecucion.";
    }

    for (const item of summary.errors) {
      const lowerError = item.error.toLowerCase();
      if (!isQuotaLikeError(lowerError)) {
        continue;
      }

      if (lowerError.includes("gemini") || lowerError.includes("generativelanguage")) {
        patch.quotaGeminiStatus = "limited";
        patch.quotaGeminiNote = trimError(item.error);
      }

      if (lowerError.includes("openai")) {
        patch.quotaOpenAiStatus = "limited";
        patch.quotaOpenAiNote = trimError(item.error);
      }
    }

    if (Object.keys(patch).length > 0) {
      patch.updatedAt = now;
    }

    return patch;
  }

  private quotaPatchFromError(
    errorMessage: string,
    now: Date
  ): Prisma.SchedulerStateUpdateManyMutationInput {
    const patch: Prisma.SchedulerStateUpdateManyMutationInput = {};
    const lowerMessage = errorMessage.toLowerCase();

    if (isQuotaLikeError(lowerMessage) && lowerMessage.includes("gemini")) {
      patch.quotaGeminiStatus = "limited";
      patch.quotaGeminiNote = trimError(errorMessage);
    }

    if (isQuotaLikeError(lowerMessage) && lowerMessage.includes("openai")) {
      patch.quotaOpenAiStatus = "limited";
      patch.quotaOpenAiNote = trimError(errorMessage);
    }

    if (Object.keys(patch).length > 0) {
      patch.updatedAt = now;
    }

    return patch;
  }
}

function createDefaultState(intervalMinutes: number): SchedulerRuntimeState {
  const now = new Date().toISOString();
  return {
    enabled: true,
    isRunning: false,
    intervalMinutes,
    lastTrigger: null,
    lastRunStartedAt: null,
    lastRunEndedAt: null,
    lastHeartbeatAt: null,
    lastError: null,
    lastSummary: null,
    totals: {
      runs: 0,
      totalFound: 0,
      processed: 0,
      skipped: 0,
      failed: 0,
      duplicatesDetected: 0,
      tokenUsage: createEmptyTokenUsageSummary(),
    },
    quota: {
      openai: {
        status: "unknown",
        note: DEFAULT_QUOTA_NOTE,
        lastUpdatedAt: null,
      },
      gemini: {
        status: "unknown",
        note: DEFAULT_QUOTA_NOTE,
        lastUpdatedAt: null,
      },
    },
    updatedAt: now,
  };
}

function toTrigger(value: string | null): SchedulerTrigger | null {
  if (value === "manual" || value === "schedule") {
    return value;
  }

  return null;
}

function maxDate(values: Array<Date | null>): string | null {
  let current: Date | null = null;

  for (const value of values) {
    if (!value) {
      continue;
    }

    if (!current || value > current) {
      current = value;
    }
  }

  return current ? current.toISOString() : null;
}

function latestError(states: SchedulerState[]): string | null {
  const withError = states.filter((state) => Boolean(state.lastError));
  if (withError.length === 0) {
    return null;
  }

  const latest = withError.reduce((acc, current) => {
    return current.updatedAt > acc.updatedAt ? current : acc;
  });

  return latest.lastError;
}

function combineQuota(
  states: SchedulerState[],
  statusField: "quotaOpenAiStatus" | "quotaGeminiStatus",
  noteField: "quotaOpenAiNote" | "quotaGeminiNote"
): ProviderQuotaState {
  const statuses = states.map((state) => normalizeQuotaStatus(state[statusField]));
  const status: QuotaStatus = statuses.includes("limited")
    ? "limited"
    : statuses.includes("ok")
      ? "ok"
      : "unknown";

  const latestWithNote = states
    .filter((state) => {
      const note = state[noteField];
      return typeof note === "string" && note.trim().length > 0;
    })
    .reduce<SchedulerState | null>((acc, current) => {
      if (!acc) {
        return current;
      }

      return current.updatedAt > acc.updatedAt ? current : acc;
    }, null);

  return {
    status,
    note: latestWithNote?.[noteField] ?? DEFAULT_QUOTA_NOTE,
    lastUpdatedAt: latestWithNote?.updatedAt.toISOString() ?? null,
  };
}

function normalizeQuotaStatus(value: string | null): QuotaStatus {
  if (value === "ok" || value === "limited" || value === "unknown") {
    return value;
  }

  return "unknown";
}

function aggregateLastSummary(states: SchedulerState[]): ProcessJobSummary | null {
  const summaries = states
    .map((state) => toSummary(state.lastSummaryJson))
    .filter((summary): summary is ProcessJobSummary => Boolean(summary));

  if (summaries.length === 0) {
    return null;
  }

  const aggregate: ProcessJobSummary = {
    totalFound: 0,
    processed: 0,
    skipped: 0,
    failed: 0,
    duplicatesDetected: 0,
    errors: [],
    tokenUsage: createEmptyTokenUsageSummary(),
    clientSummaries: [],
  };

  for (const summary of summaries) {
    aggregate.totalFound += summary.totalFound;
    aggregate.processed += summary.processed;
    aggregate.skipped += summary.skipped;
    aggregate.failed += summary.failed;
    aggregate.duplicatesDetected += summary.duplicatesDetected;
    aggregate.errors.push(...summary.errors);
    aggregate.tokenUsage.inputTokens += summary.tokenUsage.inputTokens;
    aggregate.tokenUsage.outputTokens += summary.tokenUsage.outputTokens;
    aggregate.tokenUsage.totalTokens += summary.tokenUsage.totalTokens;

    for (const [provider, total] of Object.entries(summary.tokenUsage.byProvider)) {
      aggregate.tokenUsage.byProvider[provider] =
        (aggregate.tokenUsage.byProvider[provider] ?? 0) + total;
    }

    for (const [model, total] of Object.entries(summary.tokenUsage.byModel)) {
      aggregate.tokenUsage.byModel[model] = (aggregate.tokenUsage.byModel[model] ?? 0) + total;
    }

    aggregate.clientSummaries?.push(summary);
  }

  return aggregate;
}

function toSummary(value: Prisma.JsonValue | null): ProcessJobSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const source = value as Record<string, unknown>;
  const tokenUsageSource =
    source.tokenUsage && typeof source.tokenUsage === "object" && !Array.isArray(source.tokenUsage)
      ? (source.tokenUsage as Record<string, unknown>)
      : {};

  return {
    clientId: asString(source.clientId),
    clientName: asString(source.clientName),
    totalFound: asNumber(source.totalFound),
    processed: asNumber(source.processed),
    skipped: asNumber(source.skipped),
    failed: asNumber(source.failed),
    duplicatesDetected: asNumber(source.duplicatesDetected),
    errors: asErrorArray(source.errors),
    tokenUsage: {
      inputTokens: asNumber(tokenUsageSource.inputTokens),
      outputTokens: asNumber(tokenUsageSource.outputTokens),
      totalTokens: asNumber(tokenUsageSource.totalTokens),
      byProvider: asNumberRecord(tokenUsageSource.byProvider),
      byModel: asNumberRecord(tokenUsageSource.byModel),
    },
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function asErrorArray(value: unknown): ProcessJobErrorEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }

      const row = item as Record<string, unknown>;
      return {
        fileId: typeof row.fileId === "string" ? row.fileId : "unknown",
        fileName: typeof row.fileName === "string" ? row.fileName : "unknown",
        error: typeof row.error === "string" ? row.error : "Unknown error",
      };
    })
    .filter((item): item is ProcessJobErrorEntry => Boolean(item));
}

function asNumberRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const source = value as Record<string, unknown>;
  const result: Record<string, number> = {};

  for (const [key, entry] of Object.entries(source)) {
    result[key] = asNumber(entry);
  }

  return result;
}

function trimError(message: string): string {
  return message.length > 300 ? `${message.slice(0, 300)}...` : message;
}

function isQuotaLikeError(text: string): boolean {
  return /(quota|too many requests|429|rate limit|insufficient_quota|limit: 0)/i.test(text);
}
