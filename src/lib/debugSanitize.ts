/**
 * Sanitización de strings para debug logs.
 *
 * Usado por el pipeline cuando `debugMode` está activo, para reducir la
 * exposición de PII (CUITs, importes, emails) sin perder utilidad diagnóstica.
 */

const CUIT_RE = /\b\d{2}-?\d{7,8}-?\d\b/g;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const MONEY_RE = /(?:\$|ARS|USD|U\$S)\s?[\d.,]+/gi;
const CBU_RE = /\b\d{22}\b/g;

const DEFAULT_MAX_LEN = 500;

/** Trunca preservando un sufijo informativo con la longitud original. */
export function truncateForDebugLog(text: string, maxLen: number = DEFAULT_MAX_LEN): string {
  if (typeof text !== "string") return String(text);
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}…[truncated ${text.length - maxLen} chars / total ${text.length}]`;
}

/** Redacta CUITs, emails, importes y CBU. Mantiene la estructura del texto. */
export function sanitizeForDebugLog(text: string): string {
  if (typeof text !== "string") return String(text);
  return text
    .replace(CUIT_RE, "[CUIT]")
    .replace(CBU_RE, "[CBU]")
    .replace(EMAIL_RE, "[EMAIL]")
    .replace(MONEY_RE, "[MONTO]");
}

/** Sanitiza y luego trunca — el orden importa para no cortar a la mitad un match. */
export function safeDebugLog(text: string, maxLen: number = DEFAULT_MAX_LEN): string {
  return truncateForDebugLog(sanitizeForDebugLog(text), maxLen);
}
