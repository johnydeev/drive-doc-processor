import { NextResponse } from "next/server";
import { getPrismaClient, isDatabaseConfigured } from "@/lib/prisma";

// Endpoint público (sin auth) usado por el healthcheck de Docker.
// Lo invoca docker-compose.yml cada 30s. Debe ser rápido (<1s) y verificar
// que la conexión a la DB esté realmente operativa, no solo que el server
// responda HTTP (eso ya pasaría aunque la DB esté caída).
//
// Diferencia clave vs el healthcheck anterior (que apuntaba a /login):
// /login es un form estático que pasa healthy aunque Prisma no pueda
// conectar a la DB → Docker marcaba el container OK pero la app estaba
// rota. Acá ejecutamos `SELECT 1` que falla si la conexión está perdida,
// y devolvemos 503 → Docker marca unhealthy → restart automático.

export const dynamic = "force-dynamic";

interface HealthResponse {
  status: "ok" | "error";
  db: "connected" | "disconnected" | "not_configured";
  uptime: number;
  timestamp: string;
  message?: string;
}

export async function GET() {
  const timestamp = new Date().toISOString();
  const uptime = Math.round(process.uptime());

  if (!isDatabaseConfigured()) {
    const body: HealthResponse = {
      status: "error",
      db: "not_configured",
      uptime,
      timestamp,
      message: "DATABASE_URL no está configurado",
    };
    return NextResponse.json(body, { status: 503 });
  }

  try {
    const prisma = getPrismaClient();
    // Timeout corto: si la DB tarda más de 5s en responder algo simple,
    // está degradada. Mejor marcar unhealthy y dejar que Docker reinicie.
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("DB ping timeout (5s)")), 5000)
      ),
    ]);

    const body: HealthResponse = {
      status: "ok",
      db: "connected",
      uptime,
      timestamp,
    };
    return NextResponse.json(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error desconocido";
    const body: HealthResponse = {
      status: "error",
      db: "disconnected",
      uptime,
      timestamp,
      message,
    };
    // No loguear stack completo en cada chequeo (sería 1 línea cada 30s).
    // Solo un warn corto.
    console.warn(`[health] DB check failed: ${message}`);
    return NextResponse.json(body, { status: 503 });
  }
}
