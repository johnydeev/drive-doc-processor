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
  anthropicApiKey?: string;
  anthropicModel?: string;
  [key: string]: unknown;
}

export interface ClientDriveFolders {
  pending?: string | null;
  scanned?: string | null;
  unassigned?: string | null;
  /**
   * Carpeta para archivos que necesitan revisión manual. En Drive se la
   * suele llamar "Revisión" (más amigable para el cliente). Es el destino
   * cuando se elimina una boleta desde la UI — el archivo NO debe volver
   * a `pending` porque el scheduler lo re-procesaría y crearía la misma
   * boleta de nuevo.
   */
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
