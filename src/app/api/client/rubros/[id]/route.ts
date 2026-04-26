import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireClientSession } from "@/lib/clientAuth";
import { getPrismaClient } from "@/lib/prisma";

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(255).nullable().optional(),
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
    const rubro = await prisma.rubro.findFirst({
      where: { id, clientId: auth.session.clientId },
    });
    if (!rubro) {
      return NextResponse.json({ ok: false, error: "Rubro no encontrado" }, { status: 404 });
    }

    const body = updateSchema.parse(await request.json());
    const updated = await prisma.rubro.update({
      where: { id },
      data: {
        ...(body.name !== undefined && { name: body.name.trim().toUpperCase() }),
        ...(body.description !== undefined && { description: body.description?.trim() ?? null }),
      },
    });

    return NextResponse.json({ ok: true, rubro: updated });
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
    const rubro = await prisma.rubro.findFirst({
      where: { id, clientId: auth.session.clientId },
    });
    if (!rubro) {
      return NextResponse.json({ ok: false, error: "Rubro no encontrado" }, { status: 404 });
    }

    await prisma.rubro.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Error al eliminar rubro" },
      { status: 500 }
    );
  }
}
