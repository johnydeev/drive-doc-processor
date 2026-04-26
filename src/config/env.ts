import dotenv from "dotenv";

// Carga el .env antes de leer process.env.
// En Next.js esto es un no-op porque las variables ya están cargadas.
// En los scripts de Node (scheduler, worker) esto garantiza que el .env
// esté disponible sin depender del orden de imports del llamador.
dotenv.config({ path: ".env.local" }); 
dotenv.config({ path: ".env" }); 

export interface EnvConfig {
  GOOGLE_PROJECT_ID: string;
  GOOGLE_CLIENT_EMAIL: string;
  GOOGLE_PRIVATE_KEY: string;
  GOOGLE_DRIVE_PENDING_FOLDER_ID: string;
  GOOGLE_DRIVE_SCANNED_FOLDER_ID: string;
  GOOGLE_SHEETS_ID: string;
  GOOGLE_SHEETS_SHEET_NAME: string;
  PROCESS_INTERVAL_MINUTES: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  SESSION_SECRET: string;
  DATABASE_URL: string;
  GOOGLE_CREDENTIALS_ENCRYPTION_KEY?: string;
}

const shouldSkipEnvValidation = process.env.SKIP_ENV_VALIDATION === "1";

function requireEnv(name: keyof EnvConfig): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    if (shouldSkipEnvValidation) {
      return `__MISSING_${name}__`;
    }
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: keyof EnvConfig): string | undefined {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    return undefined;
  }
  return value;
}

export const env: EnvConfig = {
  GOOGLE_PROJECT_ID: optionalEnv("GOOGLE_PROJECT_ID") ?? "",
  GOOGLE_CLIENT_EMAIL: optionalEnv("GOOGLE_CLIENT_EMAIL") ?? "",
  GOOGLE_PRIVATE_KEY: optionalEnv("GOOGLE_PRIVATE_KEY") ?? "",
  GOOGLE_DRIVE_PENDING_FOLDER_ID: optionalEnv("GOOGLE_DRIVE_PENDING_FOLDER_ID") ?? "",
  GOOGLE_DRIVE_SCANNED_FOLDER_ID: optionalEnv("GOOGLE_DRIVE_SCANNED_FOLDER_ID") ?? "",
  GOOGLE_SHEETS_ID: optionalEnv("GOOGLE_SHEETS_ID") ?? "",
  GOOGLE_SHEETS_SHEET_NAME: optionalEnv("GOOGLE_SHEETS_SHEET_NAME") ?? "Datos",
  PROCESS_INTERVAL_MINUTES: requireEnv("PROCESS_INTERVAL_MINUTES"),
  OPENAI_API_KEY: optionalEnv("OPENAI_API_KEY"),
  OPENAI_MODEL: optionalEnv("OPENAI_MODEL"),
  GEMINI_API_KEY: optionalEnv("GEMINI_API_KEY"),
  GEMINI_MODEL: optionalEnv("GEMINI_MODEL"),
  SESSION_SECRET: requireEnv("SESSION_SECRET"),
  DATABASE_URL: requireEnv("DATABASE_URL"),
  GOOGLE_CREDENTIALS_ENCRYPTION_KEY: optionalEnv("GOOGLE_CREDENTIALS_ENCRYPTION_KEY"),
};

// En producción, GOOGLE_CREDENTIALS_ENCRYPTION_KEY es obligatoria para cifrado nuevo.
// No tiramos hard fail al booteo (los secretos legados pueden seguir leyéndose con SESSION_SECRET),
// pero avisamos fuerte para que el operador la configure y corra el script de migración.
if (
  !shouldSkipEnvValidation &&
  process.env.NODE_ENV === "production" &&
  !env.GOOGLE_CREDENTIALS_ENCRYPTION_KEY
) {
  console.error(
    "[env] ❌ GOOGLE_CREDENTIALS_ENCRYPTION_KEY no configurada en producción. " +
    "Los secretos NUEVOS no podrán cifrarse (encrypt() lanzará error). " +
    "Generá una clave con `openssl rand -hex 32`, configurala y corré " +
    "`tsx scripts/rotate-encrypted-secrets.ts` para migrar secretos legados."
  );
}
