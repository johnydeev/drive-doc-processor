export type AiProvider = "gemini" | "openai" | "anthropic";

export interface AiUsageMetrics {
  provider: AiProvider;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface TokenUsageBreakdown {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface TokenUsageSummary {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  byProvider: Record<string, TokenUsageBreakdown>;
  byModel: Record<string, TokenUsageBreakdown>;
}

function ensureBreakdown(
  map: Record<string, TokenUsageBreakdown>,
  key: string
): TokenUsageBreakdown {
  if (!map[key]) {
    map[key] = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }
  return map[key];
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

  const providerEntry = ensureBreakdown(target.byProvider, usage.provider);
  providerEntry.inputTokens += usage.inputTokens;
  providerEntry.outputTokens += usage.outputTokens;
  providerEntry.totalTokens += usage.totalTokens;

  const modelEntry = ensureBreakdown(target.byModel, usage.model);
  modelEntry.inputTokens += usage.inputTokens;
  modelEntry.outputTokens += usage.outputTokens;
  modelEntry.totalTokens += usage.totalTokens;
}
