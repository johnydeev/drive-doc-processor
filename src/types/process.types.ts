import { TokenUsageSummary } from "@/types/aiUsage.types";

export interface ProcessJobErrorEntry {
  fileId: string;
  fileName: string;
  error: string;
}

export interface ProcessJobSummary {
  clientId?: string;
  clientName?: string;
  totalFound: number;
  processed: number;
  skipped: number;
  failed: number;
  duplicatesDetected: number;
  errors: ProcessJobErrorEntry[];
  tokenUsage: TokenUsageSummary;
  clientSummaries?: ProcessJobSummary[];
}
