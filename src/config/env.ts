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
  // Global Google vars are optional in multi-tenant mode.
  // Client-specific credentials/config are loaded from DB.
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
};
