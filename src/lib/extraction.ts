import { z } from "zod";
import { ExtractedDocumentData } from "@/types/extractedDocument.types";

function normalizeCuit(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const digits = value.replace(/\D/g, "");
  if (digits.length !== 11) {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  return `${digits.slice(0, 2)}-${digits.slice(2, 10)}-${digits.slice(10)}`;
}

function normalizeAmount(value: number | string | null): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? Number(value.toFixed(2)) : null;
  }

  const normalized = value.replace(/[^\d.,-]/g, "").replace(/,/g, ".").trim();
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : null;
}

export const EXTRACTED_DOCUMENT_SCHEMA = z
  .object({
    boletaNumber: z.string().nullable().default(null),
    provider: z.string().nullable().default(null),
    consortium: z.string().nullable().default(null),
    providerTaxId: z.string().nullable().default(null).transform((value) => normalizeCuit(value)),
    detail: z.string().nullable().default(null),
    observation: z.string().nullable().default(null),
    dueDate: z.string().nullable().default(null),
    amount: z
      .union([z.number(), z.string()])
      .nullable()
      .default(null)
      .transform((value) => normalizeAmount(value)),
    alias: z.string().nullable().default(null),
  })
  .strict();

const OUTPUT_JSON_TEMPLATE = {
  boletaNumber: "string | null",
  provider: "string | null",
  consortium: "string | null",
  providerTaxId: "string | null",
  detail: "string | null",
  observation: "string | null",
  dueDate: "YYYY-MM-DD | null",
  amount: "number | null",
  alias: "string | null",
};

export function buildExtractionPrompt(text: string): string {
  const clippedText = text.slice(0, 25000);

  return [
    "Extrae datos de un comprobante/factura en PDF.",
    "Responde SOLO JSON con EXACTAMENTE estas claves y tipos:",
    JSON.stringify(OUTPUT_JSON_TEMPLATE, null, 2),
    "Reglas:",
    "- Usa null si un dato falta o es incierto.",
    "- No inventes datos.",
    "- boletaNumber debe contener el numero de boleta/comprobante.",
    "- providerTaxId debe ser CUIT del proveedor (11 digitos; puedes responder con o sin guiones).",
    "- amount debe ser numerico (ejemplo 12345.67).",
    "- dueDate debe estar normalizada a YYYY-MM-DD cuando sea posible.",
    "- Si no hay vencimiento claro, dueDate = null.",
    "Texto de entrada:",
    clippedText,
  ].join("\n\n");
}

function normalizeModelOutput(raw: string): string {
  const trimmed = raw.trim();

  if (trimmed.startsWith("```") && trimmed.endsWith("```")) {
    return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  }

  return trimmed;
}

export function parseExtractionOutput(raw: string): ExtractedDocumentData {
  const normalized = normalizeModelOutput(raw || "{}");
  const parsed = JSON.parse(normalized);
  return EXTRACTED_DOCUMENT_SCHEMA.parse(parsed);
}

function normalizeLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function splitNonEmptyLines(text: string): string[] {
  return text
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => normalizeLine(line))
    .filter((line) => line.length > 0);
}

function hasLetters(value: string): boolean {
  return /[A-Za-zÁÉÍÓÚáéíóúÑñ]/.test(value);
}

function isNumericLikeLine(value: string): boolean {
  const compact = value.replace(/\s+/g, "");
  return /^[\d\-./]+$/.test(compact);
}

function isMetadataLine(value: string): boolean {
  return /^(cuit|iva|fecha|cae|comprobante|subtotal|total|domicilio|condici[oó]n|ingresos|inicio|punto de venta|c[oó]digo|regimen|otros impuestos|hys)\b/i.test(
    value
  );
}

function normalizeConsortiumValue(value: string): string {
  const noPrefix = value.replace(/^raz.{0,2}n\s*social\s*:\s*/i, "");
  return normalizeLine(noPrefix);
}

function needsConsortiumEnrichment(consortium: string | null | undefined): boolean {
  if (!consortium) {
    return true;
  }

  const normalized = normalizeLine(consortium)
    .replace(/[.,:;]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  return /^(cons|consorcio)(\s+de)?\s+prop(ietarios)?$/.test(normalized);
}

function inferConsortiumFromText(text: string): string | null {
  const lines = splitNonEmptyLines(text);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const lower = line.toLowerCase();
    const socialIndex = lower.indexOf("social");
    const colonIndex = line.indexOf(":");

    if (socialIndex < 0 || colonIndex < 0 || colonIndex >= line.length - 1) {
      continue;
    }

    const base = normalizeConsortiumValue(line.slice(colonIndex + 1));
    if (!base) {
      continue;
    }

    if (!needsConsortiumEnrichment(base)) {
      return base;
    }

    for (let j = i + 1; j < Math.min(i + 8, lines.length); j += 1) {
      const candidate = normalizeLine(lines[j]);
      if (!candidate) {
        continue;
      }

      if (isMetadataLine(candidate) || isNumericLikeLine(candidate) || !hasLetters(candidate)) {
        continue;
      }

      return `${base} ${candidate}`.trim();
    }

    return base;
  }

  return null;
}

export function refineExtractionWithRawText(
  extracted: ExtractedDocumentData,
  rawText: string
): ExtractedDocumentData {
  const inferredConsortium = inferConsortiumFromText(rawText);
  if (!inferredConsortium) {
    return extracted;
  }

  const currentConsortium = extracted.consortium ? normalizeLine(extracted.consortium) : null;
  const shouldReplace =
    needsConsortiumEnrichment(currentConsortium) ||
    !currentConsortium ||
    inferredConsortium.length > currentConsortium.length;

  if (!shouldReplace) {
    return extracted;
  }

  return {
    ...extracted,
    consortium: inferredConsortium,
  };
}
