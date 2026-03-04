import { env } from "@/config/env";
import { refineExtractionWithRawText } from "@/lib/extraction";
import {
  accumulateTokenUsage,
} from "@/types/aiUsage.types";
import { createEmptyTokenUsageSummary } from "@/types/createEmptyTokenUsageSummary";
import { ExtractedDocumentData } from "@/types/extractedDocument.types";
import { ProcessJobSummary } from "@/types/process.types";
import { ClientGoogleConfig } from "@/types/client.types";
import { InvoiceRepository } from "@/repositories/invoice.repository";
import { GoogleDriveService } from "@/services/googleDrive.service";
import { GoogleSheetsService, SheetsRowMapping } from "@/services/googleSheets.service";
import { PdfTextExtractorService } from "@/services/pdfTextExtractor.service";

export interface ProcessJobConfig {
  clientId: string;
  clientName: string;
  sheetName: string;
  mapping?: SheetsRowMapping;
  drivePendingFolderId?: string;
  driveScannedFolderId?: string;
  googleConfig?: ClientGoogleConfig | null;
  aiConfig?: {
    geminiApiKey?: string;
    geminiModel?: string;
    openaiApiKey?: string;
    openaiModel?: string;
  } | null;
}

const DEFAULT_MAPPING: SheetsRowMapping = {
  boletaNumber: "A",
  provider: "B",
  consortium: "C",
  providerTaxId: "D",
  detail: "E",
  observation: "F",
  dueDate: "G",
  amount: "H",
  alias: "I",
  sourceFileUrl: "J",
  isDuplicate: "K",
};

function toStoredExtraction(
  data: ExtractedDocumentData
): Omit<ExtractedDocumentData, "sourceFileUrl" | "isDuplicate"> {
  return {
    boletaNumber: data.boletaNumber,
    provider: data.provider,
    consortium: data.consortium,
    providerTaxId: data.providerTaxId,
    detail: data.detail,
    observation: data.observation,
    dueDate: data.dueDate,
    amount: data.amount,
    alias: data.alias,
  };
}

function toExtractedDocumentData(
  data: Omit<ExtractedDocumentData, "sourceFileUrl" | "isDuplicate">
): ExtractedDocumentData {
  return {
    boletaNumber: data.boletaNumber,
    provider: data.provider,
    consortium: data.consortium,
    providerTaxId: data.providerTaxId,
    detail: data.detail,
    observation: data.observation,
    dueDate: data.dueDate,
    amount: data.amount,
    alias: data.alias,
  };
}

function buildLegacyConfig(sheetName: string, mapping?: SheetsRowMapping): ProcessJobConfig {
  return {
    clientId: "default-env-client",
    clientName: "Default Client",
    sheetName,
    mapping,
    drivePendingFolderId: env.GOOGLE_DRIVE_PENDING_FOLDER_ID,
    driveScannedFolderId: env.GOOGLE_DRIVE_SCANNED_FOLDER_ID,
    googleConfig: null,
  };
}

function normalizeConfig(config: ProcessJobConfig | string, mapping?: SheetsRowMapping): ProcessJobConfig {
  if (typeof config === "string") {
    return buildLegacyConfig(config, mapping);
  }

  return {
    ...config,
    mapping: config.mapping ?? mapping,
    drivePendingFolderId: config.drivePendingFolderId ?? env.GOOGLE_DRIVE_PENDING_FOLDER_ID,
    driveScannedFolderId: config.driveScannedFolderId ?? env.GOOGLE_DRIVE_SCANNED_FOLDER_ID,
  };
}

export async function processPendingDocumentsJob(
  config: ProcessJobConfig | string,
  mapping?: SheetsRowMapping
): Promise<ProcessJobSummary> {
  const resolvedConfig = normalizeConfig(config, mapping);
  const resolvedMapping = resolvedConfig.mapping ?? DEFAULT_MAPPING;

  const driveService = new GoogleDriveService(resolvedConfig.googleConfig);
  const pdfExtractor = new PdfTextExtractorService();
  const sheetsService = new GoogleSheetsService(resolvedConfig.googleConfig);
  const invoiceRepository = new InvoiceRepository();
  const geminiApiKey = resolvedConfig.aiConfig?.geminiApiKey?.trim() || env.GEMINI_API_KEY?.trim();
  const openaiApiKey = resolvedConfig.aiConfig?.openaiApiKey?.trim() || env.OPENAI_API_KEY?.trim();
  const geminiModel = resolvedConfig.aiConfig?.geminiModel?.trim() || env.GEMINI_MODEL;
  const openaiModel = resolvedConfig.aiConfig?.openaiModel?.trim() || env.OPENAI_MODEL;
  const geminiModule = geminiApiKey ? await import("@/services/geminiExtractor.service") : null;
  const openAiModule = openaiApiKey ? await import("@/services/aiExtractor.service") : null;

  const files = await driveService.listPendingPdfFiles(resolvedConfig.drivePendingFolderId);
  const processedIds = new Set<string>();

  if (resolvedConfig.drivePendingFolderId === resolvedConfig.driveScannedFolderId) {
    console.warn(
      `[job:${resolvedConfig.clientId}] pending and scanned folder IDs are identical. Files may never leave the queue.`
    );
  }

  console.log(
    `[job:${resolvedConfig.clientId}] start client="${resolvedConfig.clientName}" sheet="${resolvedConfig.sheetName}" pendingFolder=${resolvedConfig.drivePendingFolderId} scannedFolder=${resolvedConfig.driveScannedFolderId}`
  );

  const summary: ProcessJobSummary = {
    clientId: resolvedConfig.clientId,
    clientName: resolvedConfig.clientName,
    totalFound: files.length,
    processed: 0,
    skipped: 0,
    failed: 0,
    duplicatesDetected: 0,
    errors: [],
    tokenUsage: createEmptyTokenUsageSummary(),
  };

  const runStep = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      throw new Error(`${label} failed: ${message}`);
    }
  };

  const buildOcrOnlyPayload = (): ExtractedDocumentData => ({
    boletaNumber: null,
    provider: null,
    consortium: null,
    providerTaxId: null,
    detail: null,
    observation: "OCR_ONLY",
    dueDate: null,
    amount: null,
    alias: null,
  });

  const buildDriveFileUrl = (fileId: string, webViewLink?: string | null): string => {
    return webViewLink?.trim() || `https://drive.google.com/file/d/${fileId}/view`;
  };

  let existingDuplicateKeys = new Set<string>();
  try {
    existingDuplicateKeys = await runStep("duplicates-load", () =>
      sheetsService.getExistingDuplicateKeys(resolvedConfig.sheetName, resolvedMapping)
    );
  } catch (error) {
    console.warn(
      `[job:${resolvedConfig.clientId}] duplicate detection bootstrap failed: ${
        error instanceof Error ? error.message : "Unknown error"
      }`
    );
  }

  if (files.length === 0) {
    const allFiles = await driveService.listAllFilesInPending(resolvedConfig.drivePendingFolderId);
    console.log(`[job:${resolvedConfig.clientId}] no PDFs found. Files in folder:`, allFiles);
  }

  for (const file of files) {
    if (processedIds.has(file.id)) {
      summary.skipped += 1;
      continue;
    }

    processedIds.add(file.id);

    try {
      console.log(`[job:${resolvedConfig.clientId}] processing fileId=${file.id} name="${file.name}"`);
      const sourceFileUrl = buildDriveFileUrl(file.id, file.webViewLink);
      const buffer = await runStep("download", () => driveService.downloadFile(file.id));

      const fileHash = invoiceRepository.computeDocumentHash(buffer);
      const existingByHash = await runStep("dedup-hash-check", () =>
        invoiceRepository.findDuplicateByHash(resolvedConfig.clientId, fileHash)
      );
      console.log(
        `[job:${resolvedConfig.clientId}] hash=${fileHash.slice(0, 8)}... duplicateByHash=${Boolean(
          existingByHash
        )}`
      );

      let extracted: ExtractedDocumentData | null = null;
      let isDuplicate = Boolean(existingByHash);

      if (existingByHash?.extraction) {
        extracted = toExtractedDocumentData(existingByHash.extraction);
        const text = await runStep("extract-text", () => pdfExtractor.extractTextFromPdf(buffer));
        extracted = refineExtractionWithRawText(extracted, text);
      } else {
        const text = await runStep("extract-text", () => pdfExtractor.extractTextFromPdf(buffer));
        const providerErrors: string[] = [];

        if (geminiModule) {
          try {
            const extractor = new geminiModule.GeminiExtractorService({
              apiKey: geminiApiKey,
              model: geminiModel,
            });
            extracted = await runStep("gemini-extract", () => extractor.extractStructuredData(text));
            accumulateTokenUsage(summary.tokenUsage, extractor.getLastUsage?.());
          } catch (error) {
            providerErrors.push(error instanceof Error ? error.message : "Gemini unknown error");
          }
        }

        if (!extracted && openAiModule) {
          try {
            const extractor = new openAiModule.AiExtractorService({
              apiKey: openaiApiKey,
              model: openaiModel,
            });
            extracted = await runStep("openai-extract", () => extractor.extractStructuredData(text));
            accumulateTokenUsage(summary.tokenUsage, extractor.getLastUsage?.());
          } catch (error) {
            providerErrors.push(error instanceof Error ? error.message : "OpenAI unknown error");
          }
        }

        if (!extracted) {
          if (providerErrors.length > 0) {
            console.warn(
              `[job:${resolvedConfig.clientId}] AI fallback to OCR_ONLY for file ${file.id} (${file.name}): ${providerErrors.join(" | ")}`
            );
          }

          extracted = buildOcrOnlyPayload();
        }
      }

      if (!isDuplicate) {
        const duplicateByBusinessKey = await runStep("dedup-business-check", () =>
          invoiceRepository.findDuplicateByBusinessKey(resolvedConfig.clientId, extracted)
        );

        isDuplicate = Boolean(duplicateByBusinessKey);
        console.log(
          `[job:${resolvedConfig.clientId}] duplicateByBusinessKey=${Boolean(duplicateByBusinessKey)}`
        );
      }

      const duplicateKey = invoiceRepository.buildBusinessKeyFromData(extracted);
      if (!isDuplicate && duplicateKey) {
        isDuplicate = existingDuplicateKeys.has(duplicateKey);
      }

      extracted.sourceFileUrl = sourceFileUrl;
      extracted.isDuplicate = isDuplicate ? "YES" : "NO";

      await runStep("sheets-insert", () =>
        sheetsService.insertRow(resolvedConfig.sheetName, extracted, resolvedMapping)
      );
      await runStep("move-to-scanned", () =>
        driveService.moveFileToScanned(
          file.id,
          resolvedConfig.drivePendingFolderId,
          resolvedConfig.driveScannedFolderId
        )
      );
      console.log(
        `[job:${resolvedConfig.clientId}] moved fileId=${file.id} to scannedFolder=${resolvedConfig.driveScannedFolderId}`
      );

      await runStep("invoice-save", () =>
        invoiceRepository.saveProcessedInvoice({
          clientId: resolvedConfig.clientId,
          documentHash: fileHash,
          fileId: file.id,
          sourceFileUrl,
          extraction: toStoredExtraction(extracted),
          isDuplicate,
        })
      );

      if (duplicateKey) {
        existingDuplicateKeys.add(duplicateKey);
      }

      if (isDuplicate) {
        summary.duplicatesDetected += 1;
      }

      summary.processed += 1;
      console.log(
        `[job:${resolvedConfig.clientId}] done fileId=${file.id} duplicate=${isDuplicate} processed=${summary.processed} failed=${summary.failed}`
      );
    } catch (error) {
      summary.failed += 1;
      summary.errors.push({
        fileId: file.id,
        fileName: file.name,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      console.error(
        `[job:${resolvedConfig.clientId}] failed fileId=${file.id} name="${file.name}" error=${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }

  console.log(
    `[job:${resolvedConfig.clientId}] summary totalFound=${summary.totalFound} processed=${summary.processed} failed=${summary.failed} duplicates=${summary.duplicatesDetected}`
  );

  return summary;
}
