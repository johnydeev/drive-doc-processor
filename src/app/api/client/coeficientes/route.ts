import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuthenticatedSession } from "@/lib/adminAuth";
import { requireClientSession } from "@/lib/clientAuth";
import { getPrismaClient } from "@/lib/prisma";

const createSchema = z.object({
  code: z.string().min(1).max(10),
  name: z.string().min(1).max(100),
  value: z.number().positive().optional(),
});

export async function GET(request: NextRequest) {
  const auth = requireAuthenticatedSession(request);
  if (auth.error) return auth.error;

  try {
    const prisma = getPrismaClient();
    const coeficientes = await prisma.coeficiente.findMany({
      where: { clientId: auth.session.clientId },
      orderBy: { code: "asc" },
    });
    return NextResponse.json({ ok: true, coeficientes });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Error al obtener coeficientes" },
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

    const coeficiente = await prisma.coeficiente.create({
      data: {
        clientId: auth.session.clientId,
        code: body.code.trim().toUpperCase(),
        name: body.name.trim().toUpperCase(),
        value: body.value ?? null,
      },
    });

    return NextResponse.json({ ok: true, coeficiente }, { status: 201 });
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
