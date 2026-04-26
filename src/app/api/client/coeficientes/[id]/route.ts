import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireClientSession } from "@/lib/clientAuth";
import { getPrismaClient } from "@/lib/prisma";

const updateSchema = z.object({
  code: z.string().min(1).max(10).optional(),
  name: z.string().min(1).max(100).optional(),
  value: z.number().positive().nullable().optional(),
});

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const auth = requireClientSession(request);
  if (auth.error) return auth.error;

  const { id } = await context.params;

  try {
    const prisma = getPrismaClient();
    const coeficiente = await prisma.coeficiente.findFirst({
      where: { id, clientId: auth.session.clientId },
    });
    if (!coeficiente) {
      return NextResponse.json({ ok: false, error: "Coeficiente no encontrado" }, { status: 404 });
    }

    const body = updateSchema.parse(await request.json());
    const updated = await prisma.coeficiente.update({
      where: { id },
      data: {
        ...(body.code !== undefined && { code: body.code.trim().toUpperCase() }),
        ...(body.name !== undefined && { name: body.name.trim().toUpperCase() }),
        ...(body.value !== undefined && { value: body.value }),
      },
    });

    return NextResponse.json({ ok: true, coeficiente: updated });
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

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const auth = requireClientSession(request);
  if (auth.error) return auth.error;

  const { id } = await context.params;

  try {
    const prisma = getPrismaClient();
    const coeficiente = await prisma.coeficiente.findFirst({
      where: { id, clientId: auth.session.clientId },
    });
    if (!coeficiente) {
      return NextResponse.json({ ok: false, error: "Coeficiente no encontrado" }, { status: 404 });
    }

    await prisma.coeficiente.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Error al eliminar coeficiente" },
      { status: 500 }
    );
  }
}
