import { ProcessJobSummary } from "@/types/process.types";
import { TokenUsageSummary } from "@/types/aiUsage.types";

export type SchedulerTrigger = "schedule" | "manual";
export type QuotaStatus = "unknown" | "ok" | "limited";

export interface ProviderQuotaState {
  status: QuotaStatus;
  note: string;
  lastUpdatedAt: string | null;
}

export interface SchedulerTotals {
  runs: number;
  totalFound: number;
  processed: number;
  skipped: number;
  failed: number;
  duplicatesDetected: number;
  tokenUsage: TokenUsageSummary;
}

export interface SchedulerRuntimeState {
  enabled: boolean;
  isRunning: boolean;
  intervalMinutes: number;
  lastTrigger: SchedulerTrigger | null;
  lastRunStartedAt: string | null;
  lastRunEndedAt: string | null;
  lastHeartbeatAt: string | null;
  lastError: string | null;
  lastSummary: ProcessJobSummary | null;
  totals: SchedulerTotals;
  quota: {
    openai: ProviderQuotaState;
    gemini: ProviderQuotaState;
  };
  updatedAt: string;
}
