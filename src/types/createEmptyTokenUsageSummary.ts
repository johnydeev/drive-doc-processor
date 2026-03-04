import { TokenUsageSummary } from "./aiUsage.types";


export function createEmptyTokenUsageSummary(): TokenUsageSummary {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    byProvider: {},
    byModel: {},
  };
}
