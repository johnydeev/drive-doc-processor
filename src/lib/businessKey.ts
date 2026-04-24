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

/**
 * Normaliza un monto a string numérico con 2 decimales para comparación.
 *
 * Soporta todos los formatos que puede recibir:
 *   - número: 118000 → "118000.00"
 *   - es-AR texto: "$ 118.000,00" → "118000.00"
 *   - plano: "118000" → "118000.00"
 *   - en-US: "$ 118,000.00" → "118000.00"
 */
export function normalizeBusinessAmount(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  // Si ya es número, formatear directo
  if (typeof value === "number") {
    return Number.isFinite(value) ? value.toFixed(2) : "";
  }

  const raw = String(value).trim();
  if (!raw) return "";

  // Quitar símbolo de moneda y espacios
  const stripped = raw.replace(/\$/g, "").trim();

  // Detectar formato es-AR: tiene punto como separador de miles y coma como decimal
  // Ejemplo: "118.000,00" o "1.550.550,00"
  const esArPattern = /^[\d.]+,\d{1,2}$/;
  if (esArPattern.test(stripped)) {
    // Quitar puntos de miles, reemplazar coma decimal por punto
    const normalized = stripped.replace(/\./g, "").replace(",", ".");
    const parsed = Number.parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed.toFixed(2) : "";
  }

  // Detectar formato en-US: tiene coma como separador de miles y punto como decimal
  // Ejemplo: "118,000.00"
  const enUsPattern = /^[\d,]+\.\d{1,2}$/;
  if (enUsPattern.test(stripped)) {
    const normalized = stripped.replace(/,/g, "");
    const parsed = Number.parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed.toFixed(2) : "";
  }

  // Formato plano sin separadores: "118000" o "118000.50"
  const parsed = Number.parseFloat(stripped.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed.toFixed(2) : normalizeBusinessText(value);
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

/**
 * Evalúa si dos extracted data son duplicados.
 * Regla: si boletaNumber está presente en ambos y son DISTINTOS → NO duplicado.
 * Solo se considera duplicado si todos los campos presentes coinciden.
 */
export function isDuplicateByPriority(
  existing: BusinessKeyParts,
  incoming: BusinessKeyParts
): boolean {
  // Si ambos tienen boletaNumber y son distintos → nunca duplicado
  if (
    existing.boletaNumberNorm &&
    incoming.boletaNumberNorm &&
    existing.boletaNumberNorm !== incoming.boletaNumberNorm
  ) {
    return false;
  }

  // Si boletaNumber coincide (o alguno está vacío), verificar los demás campos
  // Solo son duplicados si todos los campos no vacíos coinciden
  const fields: (keyof BusinessKeyParts)[] = [
    "boletaNumberNorm",
    "providerTaxIdNorm",
    "dueDateNorm",
    "amountNorm",
  ];

  for (const field of fields) {
    const a = existing[field];
    const b = incoming[field];
    // Si ambos tienen valor y son distintos → no duplicado
    if (a && b && a !== b) return false;
  }

  // Todos los campos presentes coinciden → duplicado
  return true;
}
