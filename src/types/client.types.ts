export interface ClientGoogleConfig {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  sheetsId: string;
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

export interface ProcessingClient {
  id: string;
  name: string;
  isActive: boolean;
  driveFolderPending: string;
  driveFolderProcessed: string;
  googleConfigJson?: ClientGoogleConfig | null;
  extractionConfigJson?: ClientExtractionConfig | null;
}
