import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

let hasLoggedDatabaseMode = false;

export function isDatabaseConfigured(): boolean {
  const url = process.env.DATABASE_URL?.trim();
  const configured = Boolean(url);

  if (!hasLoggedDatabaseMode) {
    if (configured) {
      console.log(`[prisma] database mode enabled target=${describeDatabaseTarget(url as string)}`);
    } else {
      console.warn("[prisma] DATABASE_URL not set. Database mode is required.");
    }
    hasLoggedDatabaseMode = true;
  }

  return configured;
}

export function getPrismaClient(): PrismaClient {
  if (!isDatabaseConfigured()) {
    throw new Error("DATABASE_URL is not configured");
  }

  if (!globalForPrisma.prisma) {
    const datasourceUrl = buildDatasourceUrlForRuntime(process.env.DATABASE_URL as string);
    globalForPrisma.prisma = new PrismaClient({
      datasources: {
        db: {
          url: datasourceUrl,
        },
      },
      log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
    });
    console.log("[prisma] PrismaClient initialized");
  }

  return globalForPrisma.prisma;
}

export function isPrismaConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("can't reach database") ||
    message.includes("database") ||
    message.includes("connection") ||
    message.includes("p1001") ||
    message.includes("p1000") ||
    message.includes("p2021") ||
    message.includes("p2022") ||
    message.includes("does not exist")
  );
}

function describeDatabaseTarget(url: string): string {
  try {
    const parsed = new URL(url);
    const dbName = parsed.pathname.replace(/^\//, "") || "<unknown>";
    const host = parsed.hostname || "<unknown>";
    const port = parsed.port || "5432";
    return `${host}:${port}/${dbName}`;
  } catch {
    return "<unparseable>";
  }
}

function buildDatasourceUrlForRuntime(url: string): string {
  try {
    const parsed = new URL(url);
    const isSupabasePooler = parsed.hostname.endsWith("pooler.supabase.com");
    if (!isSupabasePooler) {
      return url;
    }

    // Supabase pooler + Next dev + multiple workers can easily saturate Prisma's
    // default local pool. Keep a tiny pool per process and wait longer.
    if (!parsed.searchParams.has("pgbouncer")) {
      parsed.searchParams.set("pgbouncer", "true");
    }
    if (!parsed.searchParams.has("connection_limit")) {
      parsed.searchParams.set("connection_limit", "3");
    }
    if (!parsed.searchParams.has("pool_timeout")) {
      parsed.searchParams.set("pool_timeout", "30");
    }

    return parsed.toString();
  } catch {
    return url;
  }
}
