export type AiProvider = "gemini" | "openai";

export interface AiUsageMetrics {
  provider: AiProvider;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface TokenUsageSummary {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  byProvider: Record<string, number>;
  byModel: Record<string, number>;
}

export function accumulateTokenUsage(
  target: TokenUsageSummary,
  usage: AiUsageMetrics | null | undefined
): void {
  if (!usage) {
    return;
  }

  target.inputTokens += usage.inputTokens;
  target.outputTokens += usage.outputTokens;
  target.totalTokens += usage.totalTokens;

  target.byProvider[usage.provider] = (target.byProvider[usage.provider] ?? 0) + usage.totalTokens;
  target.byModel[usage.model] = (target.byModel[usage.model] ?? 0) + usage.totalTokens;
}
