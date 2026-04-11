export interface ClientGoogleConfig {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  sheetsId: string;
  altaSheetsId?: string;
}

export interface ClientExtractionConfig {
  sheetName?: string;
  columnMapping?: Record<string, string>;
  geminiApiKey?: string;
  openaiApiKey?: string;
  geminiModel?: string;
  openaiModel?: string;
  [key: string]: unknown;
}

export interface ClientDriveFolders {
  pending?: string | null;
  scanned?: string | null;
  unassigned?: string | null;
  failed?: string | null;
  receipts?: string | null;
  processing?: string | null;
}

export interface ProcessingClient {
  id: string;
  name: string;
  isActive: boolean;
  batchSize: number;
  intervalMinutes: number;
  driveFoldersJson?: ClientDriveFolders | null;
  googleConfigJson?: ClientGoogleConfig | null;
  extractionConfigJson?: ClientExtractionConfig | null;
}
