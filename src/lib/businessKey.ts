import { ExtractedDocumentData } from "@/types/extractedDocument.types";

export interface BusinessKeyParts {
  boletaNumberNorm: string;
  providerTaxIdNorm: string;
  dueDateNorm: string;
  amountNorm: string;
}

export function normalizeBusinessText(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value).trim().toLowerCase();
}

export function normalizeBusinessAmount(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  const numeric = String(value).replace(/[^\d.,-]/g, "").replace(/,/g, ".").trim();
  const parsed = Number.parseFloat(numeric);

  if (!Number.isFinite(parsed)) {
    return normalizeBusinessText(value);
  }

  return parsed.toFixed(2);
}

export function normalizeBusinessDueDate(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  const raw = String(value).trim();
  if (raw.length === 0) {
    return "";
  }

  const isoCandidate = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoCandidate) {
    return raw;
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return normalizeBusinessText(raw);
  }

  return parsed.toISOString().slice(0, 10);
}

export function buildBusinessKeyParts(data: ExtractedDocumentData): BusinessKeyParts {
  return {
    boletaNumberNorm: normalizeBusinessText(data.boletaNumber),
    providerTaxIdNorm: normalizeBusinessText(data.providerTaxId),
    dueDateNorm: normalizeBusinessDueDate(data.dueDate),
    amountNorm: normalizeBusinessAmount(data.amount),
  };
}

export function hasUsefulBusinessKey(parts: BusinessKeyParts): boolean {
  return (
    parts.boletaNumberNorm.length > 0 ||
    parts.providerTaxIdNorm.length > 0 ||
    parts.dueDateNorm.length > 0 ||
    parts.amountNorm.length > 0
  );
}

export function buildBusinessKeyString(parts: BusinessKeyParts): string | null {
  if (!hasUsefulBusinessKey(parts)) {
    return null;
  }

  return [
    parts.boletaNumberNorm,
    parts.providerTaxIdNorm,
    parts.dueDateNorm,
    parts.amountNorm,
  ].join("|");
}
