import { env } from "@/config/env";
import { SheetsRowMapping } from "@/services/googleSheets.service";
import { ClientDriveFolders, ClientGoogleConfig, ProcessingClient } from "@/types/client.types";
import { decrypt } from "@/utils/encryption.util";

export function resolveSheetName(client: ProcessingClient): string {
  const fromConfig = client.extractionConfigJson?.sheetName;
  if (typeof fromConfig === "string" && fromConfig.trim().length > 0) {
    return fromConfig.trim();
  }

  return env.GOOGLE_SHEETS_SHEET_NAME;
}

export function resolveMapping(client: ProcessingClient): SheetsRowMapping | undefined {
  const raw = client.extractionConfigJson?.columnMapping;
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const requiredKeys: Array<keyof SheetsRowMapping> = [
    "boletaNumber",
    "provider",
    "consortium",
    "providerTaxId",
    "detail",
    "observation",
    "dueDate",
    "amount",
    "alias",
    "clientNumber",
    "sourceFileUrl",
    "isDuplicate",
    "period",
    "paymentStatus",
    "bank",
  ];

  const parsed = raw as Record<string, unknown>;
  for (const key of requiredKeys) {
    if (typeof parsed[key] !== "string" || parsed[key].trim().length === 0) {
      return undefined;
    }
  }

  return parsed as unknown as SheetsRowMapping;
}

export function resolveGoogleConfig(client: ProcessingClient): ClientGoogleConfig | null {
  const raw = client.googleConfigJson;
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const projectId = asRequiredString(raw.projectId);
  const clientEmail = asRequiredString(raw.clientEmail);
  const privateKeyRaw = asRequiredString(raw.privateKey);
  const sheetsId = asRequiredString(raw.sheetsId);

  if (!projectId || !clientEmail || !privateKeyRaw || !sheetsId) {
    return null;
  }

  return {
    projectId,
    clientEmail,
    privateKey: decrypt(privateKeyRaw),
    sheetsId,
  };
}

export function resolveAiConfig(client: ProcessingClient): {
  geminiApiKey?: string;
  geminiModel?: string;
  openaiApiKey?: string;
  openaiModel?: string;
} | null {
  const raw = client.extractionConfigJson;
  if (!raw || typeof raw !== "object") {
    return null;
  }

  // Las API keys se guardan cifradas — hay que descifrarlas antes de usarlas
  const geminiApiKeyRaw = asOptionalString(raw.geminiApiKey);
  const openaiApiKeyRaw = asOptionalString(raw.openaiApiKey);
  const geminiModel = asOptionalString(raw.geminiModel);
  const openaiModel = asOptionalString(raw.openaiModel);

  const geminiApiKey = geminiApiKeyRaw ? decrypt(geminiApiKeyRaw) : undefined;
  const openaiApiKey = openaiApiKeyRaw ? decrypt(openaiApiKeyRaw) : undefined;

  if (!geminiApiKey && !openaiApiKey && !geminiModel && !openaiModel) {
    return null;
  }

  return { geminiApiKey, geminiModel, openaiApiKey, openaiModel };
}

export interface ResolvedFolders {
  pending: string;
  scanned: string;
  unassigned: string | null;
  failed: string | null;
  receipts: string | null;
}

export function resolveFolders(client: ProcessingClient): ResolvedFolders {
  const f = client.driveFoldersJson as ClientDriveFolders | null | undefined;

  return {
    pending:    f?.pending?.trim()    || env.GOOGLE_DRIVE_PENDING_FOLDER_ID  || "",
    scanned:    f?.scanned?.trim()    || env.GOOGLE_DRIVE_SCANNED_FOLDER_ID  || "",
    unassigned: f?.unassigned?.trim() || null,
    failed:     f?.failed?.trim()     || null,
    receipts:   f?.receipts?.trim()   || null,
  };
}

export function validateClientProcessingConfig(
  client: ProcessingClient,
  sheetName: string,
  googleConfig: ClientGoogleConfig | null
): void {
  const folders = resolveFolders(client);

  if (!folders.pending) {
    throw new Error("Missing required client config: driveFoldersJson.pending");
  }

  if (!folders.scanned) {
    throw new Error("Missing required client config: driveFoldersJson.scanned");
  }

  if (folders.pending === folders.scanned) {
    throw new Error("Invalid client config: pending and scanned folders must be different");
  }

  if (!sheetName.trim()) {
    throw new Error("Missing required client config: sheetName");
  }

  if (!googleConfig) {
    throw new Error("Missing required client config: google credentials (projectId/clientEmail/privateKey/sheetsId)");
  }
}

function asRequiredString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
