import OpenAI from "openai";
import { env } from "@/config/env";
import {
  buildExtractionPrompt,
  parseExtractionOutput,
  refineExtractionWithRawText,
} from "@/lib/extraction";
import { AiUsageMetrics } from "@/types/aiUsage.types";
import { ExtractedDocumentData } from "@/types/extractedDocument.types";

export class AiExtractorService {
  private client: OpenAI;
  private model: string;
  private lastUsage: AiUsageMetrics | null = null;

  constructor(options?: { apiKey?: string; model?: string }) {
    const apiKey = options?.apiKey?.trim() || env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is required to use AiExtractorService");
    }

    this.client = new OpenAI({ apiKey });
    this.model = options?.model?.trim() || env.OPENAI_MODEL || "gpt-4o-mini";
  }

  async extractStructuredData(text: string): Promise<ExtractedDocumentData> {
    this.lastUsage = null;
    const prompt = buildExtractionPrompt(text);

    const response = await this.client.responses.create({
      model: this.model,
      temperature: 0,
      input: prompt,
    });

    const outputText = response.output_text ?? "{}";
    const parsed = parseExtractionOutput(outputText);
    const usage = response.usage as
      | {
          input_tokens?: number;
          output_tokens?: number;
          total_tokens?: number;
          prompt_tokens?: number;
          completion_tokens?: number;
        }
      | undefined;

    const inputTokens = Number(usage?.input_tokens ?? usage?.prompt_tokens ?? 0);
    const outputTokens = Number(usage?.output_tokens ?? usage?.completion_tokens ?? 0);
    const totalTokens = Number(usage?.total_tokens ?? inputTokens + outputTokens);

    this.lastUsage = {
      provider: "openai",
      model: this.model,
      inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
      outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
      totalTokens: Number.isFinite(totalTokens) ? totalTokens : 0,
    };

    return refineExtractionWithRawText(parsed, text);
  }

  getLastUsage(): AiUsageMetrics | null {
    return this.lastUsage;
  }
}
