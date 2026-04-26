import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuthenticatedSession } from "@/lib/adminAuth";
import { requireClientSession } from "@/lib/clientAuth";
import { getPrismaClient } from "@/lib/prisma";

const createSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(255).optional(),
});

export async function GET(request: NextRequest) {
  const auth = requireAuthenticatedSession(request);
  if (auth.error) return auth.error;

  try {
    const prisma = getPrismaClient();
    const rubros = await prisma.rubro.findMany({
      where: { clientId: auth.session.clientId },
      orderBy: { name: "asc" },
    });
    return NextResponse.json({ ok: true, rubros });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Error al obtener rubros" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const auth = requireClientSession(request);
  if (auth.error) return auth.error;

  try {
    const prisma = getPrismaClient();
    const body = createSchema.parse(await request.json());

    const rubro = await prisma.rubro.create({
      data: {
        clientId: auth.session.clientId,
        name: body.name.trim().toUpperCase(),
        description: body.description?.trim() ?? null,
      },
    });

    return NextResponse.json({ ok: true, rubro }, { status: 201 });
  } catch (error) {
    const message =
      error instanceof z.ZodError
        ? error.issues.map((i) => i.message).join(", ")
        : error instanceof Error
          ? error.message
          : "Unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
