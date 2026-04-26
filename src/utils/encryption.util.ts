import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const PREFIX_LEGACY = "enc:";
const PREFIX_V2 = "enc:v2:";

/**
 * Esquema de cifrado:
 *
 *   Legado: "enc:<iv>.<tag>.<data>"
 *     - clave derivada de GOOGLE_CREDENTIALS_ENCRYPTION_KEY o de SESSION_SECRET
 *       (no se sabe a priori cuál se usó al cifrar — depende del histórico).
 *     - SOLO LECTURA. Se prueban ambas claves candidatas; AES-256-GCM rechaza
 *       limpiamente con auth-tag mismatch si la clave es incorrecta.
 *
 *   v2:     "enc:v2:<iv>.<tag>.<data>"
 *     - clave derivada exclusivamente de GOOGLE_CREDENTIALS_ENCRYPTION_KEY.
 *     - es el formato usado para todo cifrado nuevo.
 *
 * Migración: scripts/rotate-encrypted-secrets.ts re-cifra los registros
 * legados a v2 sin perder secretos existentes.
 */

let legacyFallbackWarningShown = false;

function deriveKey(raw: string): Buffer {
  return createHash("sha256").update(raw, "utf8").digest();
}

function getEncryptionKeyV2(): Buffer {
  const raw = process.env.GOOGLE_CREDENTIALS_ENCRYPTION_KEY;
  if (!raw || raw.trim().length === 0) {
    throw new Error(
      "GOOGLE_CREDENTIALS_ENCRYPTION_KEY is required to encrypt new secrets. " +
      "Configure it in your .env (use `openssl rand -hex 32`)."
    );
  }
  return deriveKey(raw);
}

/**
 * Devuelve las claves candidatas para descifrar legacy, en orden de preferencia.
 * Filtra duplicados (caso GOOGLE_CREDENTIALS_ENCRYPTION_KEY === SESSION_SECRET).
 */
function getLegacyDecryptionCandidates(): Buffer[] {
  const candidates: { source: string; raw: string | undefined }[] = [
    { source: "GOOGLE_CREDENTIALS_ENCRYPTION_KEY", raw: process.env.GOOGLE_CREDENTIALS_ENCRYPTION_KEY },
    { source: "SESSION_SECRET", raw: process.env.SESSION_SECRET },
  ];

  const seen = new Set<string>();
  const keys: Buffer[] = [];
  for (const { raw } of candidates) {
    if (!raw || raw.trim().length === 0) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    keys.push(deriveKey(raw));
  }

  if (keys.length === 0) {
    throw new Error(
      "Neither GOOGLE_CREDENTIALS_ENCRYPTION_KEY nor SESSION_SECRET configured — " +
      "cannot decrypt legacy secrets"
    );
  }

  return keys;
}

function encryptWithKey(text: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${encrypted.toString("base64")}`;
}

function decryptWithKey(payload: string, key: Buffer): string {
  const [ivB64, tagB64, dataB64] = payload.split(".");
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("Invalid encrypted value format");
  }
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString("utf8");
}

/** Prueba descifrar con cada clave candidata. AES-GCM falla limpio si la clave es errónea. */
function decryptLegacyTryingCandidates(payload: string): string {
  const keys = getLegacyDecryptionCandidates();
  let lastError: unknown = null;
  for (const key of keys) {
    try {
      return decryptWithKey(payload, key);
    } catch (err) {
      lastError = err;
      continue;
    }
  }

  if (
    !legacyFallbackWarningShown &&
    process.env.GOOGLE_CREDENTIALS_ENCRYPTION_KEY &&
    process.env.SESSION_SECRET
  ) {
    // Avisar una vez si seguimos cayendo a SESSION_SECRET para registros legacy.
    legacyFallbackWarningShown = true;
    console.warn(
      "[encryption] Legacy secret no se pudo descifrar con ninguna clave candidata. " +
      "Verificá que GOOGLE_CREDENTIALS_ENCRYPTION_KEY y SESSION_SECRET sean los correctos " +
      "y luego corré scripts/rotate-encrypted-secrets.ts para migrar a v2."
    );
  }

  throw new Error(
    `Failed to decrypt legacy secret with any candidate key: ${
      lastError instanceof Error ? lastError.message : "unknown"
    }`
  );
}

/**
 * Cifra siempre con el esquema v2 (clave dedicada).
 * Si el valor ya viene con prefijo `enc:` (cualquier versión), se devuelve tal cual.
 */
export function encrypt(text: string): string {
  if (!text) return text;
  if (text.startsWith(PREFIX_LEGACY)) return text; // ya cifrado (legado o v2)

  const key = getEncryptionKeyV2();
  return `${PREFIX_V2}${encryptWithKey(text, key)}`;
}

/**
 * Descifra valores en formato v2 o legado.
 * Texto plano (sin prefijo) se devuelve sin tocar.
 *
 * Para legacy se prueban todas las claves candidatas (GCEK + SESSION_SECRET)
 * porque el histórico podría haber cifrado con cualquiera de las dos.
 */
export function decrypt(text: string): string {
  if (!text) return text;

  if (text.startsWith(PREFIX_V2)) {
    const payload = text.slice(PREFIX_V2.length);
    const key = getEncryptionKeyV2();
    return decryptWithKey(payload, key);
  }

  if (text.startsWith(PREFIX_LEGACY)) {
    const payload = text.slice(PREFIX_LEGACY.length);
    return decryptLegacyTryingCandidates(payload);
  }

  return text;
}

/** True si el valor está cifrado con el esquema legado (no v2). */
export function isLegacyEncrypted(text: string | null | undefined): boolean {
  if (!text) return false;
  return text.startsWith(PREFIX_LEGACY) && !text.startsWith(PREFIX_V2);
}
