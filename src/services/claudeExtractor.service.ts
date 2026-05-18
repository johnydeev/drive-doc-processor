import Anthropic from "@anthropic-ai/sdk";
import { env } from "@/config/env";
import {
  buildExtractionPrompt,
  parseExtractionOutput,
  refineExtractionWithRawText,
} from "@/lib/extraction";
import { AiUsageMetrics } from "@/types/aiUsage.types";
import { ExtractedDocumentData } from "@/types/extractedDocument.types";

export class ClaudeExtractorService {
  private client: Anthropic;
  private model: string;
  private lastUsage: AiUsageMetrics | null = null;

  constructor(options?: { apiKey?: string; model?: string }) {
    const apiKey = options?.apiKey?.trim() || env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY is required to use ClaudeExtractorService");
    }
    this.client = new Anthropic({ apiKey });
    this.model = options?.model?.trim() || env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
  }

  async extractStructuredData(text: string): Promise<ExtractedDocumentData> {
    this.lastUsage = null;
    const prompt = buildExtractionPrompt(text);

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      temperature: 0,
      messages: [{ role: "user", content: prompt }],
    });

    const outputBlock = response.content.find((b) => b.type === "text");
    const outputText = outputBlock?.type === "text" ? outputBlock.text : "{}";
    const parsed = parseExtractionOutput(outputText);

    const inputTokens = response.usage?.input_tokens ?? 0;
    const outputTokens = response.usage?.output_tokens ?? 0;

    this.lastUsage = {
      provider: "anthropic",
      model: this.model,
      inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
      outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
      totalTokens: Number.isFinite(inputTokens + outputTokens) ? inputTokens + outputTokens : 0,
    };

    return refineExtractionWithRawText(parsed, text);
  }

  getLastUsage(): AiUsageMetrics | null {
    return this.lastUsage;
  }
}
