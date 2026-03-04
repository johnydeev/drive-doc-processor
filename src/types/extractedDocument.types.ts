export interface ExtractedDocumentData {
  boletaNumber: string | null;
  provider: string | null;
  consortium: string | null;
  providerTaxId: string | null;
  detail: string | null;
  observation: string | null;
  dueDate: string | null;
  amount: number | null;
  alias: string | null;
  sourceFileUrl?: string | null;
  isDuplicate?: "YES" | "NO" | null;
}