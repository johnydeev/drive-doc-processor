import { GoogleGenerativeAI, GenerativeModel } from "@google/generative-ai";
import { env } from "@/config/env";
import {
  buildExtractionPrompt,
  parseExtractionOutput,
  refineExtractionWithRawText,
} from "@/lib/extraction";
import { AiUsageMetrics } from "@/types/aiUsage.types";
import { ExtractedDocumentData } from "@/types/extractedDocument.types";

const DEFAULT_MODEL_CANDIDATES = [
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-flash-latest",
  "gemini-2.0-flash",
  "gemini-2.0-flash-lite",
  "gemini-2.5-pro",
];

function normalizeError(error: unknown): string {
  if (error instanceof Error) {
    const firstLine = error.message.split("\n")[0]?.trim() ?? error.message;
    const compact = firstLine.length > 220 ? `${firstLine.slice(0, 220)}...` : firstLine;
    const codeMatch = firstLine.match(/\[(\d{3})\s/);
    if (codeMatch) {
      return `HTTP ${codeMatch[1]}: ${compact}`;
    }
    return compact;
  }
  const text = String(error);
  const firstLine = text.split("\n")[0]?.trim() ?? text;
  return firstLine.length > 220 ? `${firstLine.slice(0, 220)}...` : firstLine;
}

export class GeminiExtractorService {
  private static workingModelName: string | null = null;
  private readonly genAI: GoogleGenerativeAI;
  private readonly preferredModel?: string;
  private lastUsage: AiUsageMetrics | null = null;

  constructor(options?: { apiKey?: string; model?: string }) {
    const apiKey = options?.apiKey?.trim() || env.GEMINI_API_KEY?.trim();
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY is not configured");
    }

    this.genAI = new GoogleGenerativeAI(apiKey);
    this.preferredModel = options?.model?.trim() || env.GEMINI_MODEL?.trim() || undefined;
  }

  private buildModelCandidates(): string[] {
    const ordered = [this.preferredModel, GeminiExtractorService.workingModelName, ...DEFAULT_MODEL_CANDIDATES].filter(
      (value): value is string => Boolean(value)
    );

    return [...new Set(ordered)];
  }

  private getModel(modelName: string): GenerativeModel {
    return this.genAI.getGenerativeModel({ model: modelName });
  }

  async extractStructuredData(text: string): Promise<ExtractedDocumentData> {
    if (!text.trim()) {
      throw new Error("No text provided for Gemini extraction");
    }

    this.lastUsage = null;
    const prompt = buildExtractionPrompt(text);
    const errors: string[] = [];

    for (const modelName of this.buildModelCandidates()) {
      try {
        const model = this.getModel(modelName);
        const response = await model.generateContent({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0,
            responseMimeType: "application/json",
          },
        });

        const outputText = response.response.text() || "{}";
        const parsed = parseExtractionOutput(outputText);
        const refined = refineExtractionWithRawText(parsed, text);
        const usageMetadata = (
          response.response as unknown as {
            usageMetadata?: {
              promptTokenCount?: number;
              candidatesTokenCount?: number;
              totalTokenCount?: number;
            };
          }
        ).usageMetadata;

        const inputTokens = Number(usageMetadata?.promptTokenCount ?? 0);
        const outputTokens = Number(usageMetadata?.candidatesTokenCount ?? 0);
        const totalTokens = Number(
          usageMetadata?.totalTokenCount ?? inputTokens + outputTokens
        );

        this.lastUsage = {
          provider: "gemini",
          model: modelName,
          inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
          outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
          totalTokens: Number.isFinite(totalTokens) ? totalTokens : 0,
        };

        GeminiExtractorService.workingModelName = modelName;
        return refined;
      } catch (error) {
        errors.push(`${modelName}: ${normalizeError(error)}`);
      }
    }

    const allErrors = errors.join(" | ");
    if (allErrors.toLowerCase().includes("free_tier") && allErrors.toLowerCase().includes("limit: 0")) {
      throw new Error(
        "Gemini API key/project has zero available free-tier quota (limit: 0). Verify AI Studio key project and quota activation."
      );
    }

    throw new Error(`Gemini extraction failed for all candidate models. ${errors.join(" | ")}`);
  }

  getLastUsage(): AiUsageMetrics | null {
    return this.lastUsage;
  }
}
