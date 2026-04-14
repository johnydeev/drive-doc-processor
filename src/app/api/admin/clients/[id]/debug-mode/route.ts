import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { requireAdminSession } from "@/lib/adminAuth";
import { getPrismaClient } from "@/lib/prisma";

const bodySchema = z.object({
  debugMode: z.boolean(),
});

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const auth = requireAdminSession(request);
  if (auth.error) return auth.error;

  const { id } = await context.params;

  try {
    const prisma = getPrismaClient();

    const client = await prisma.client.findUnique({ where: { id } });
    if (!client) {
      return NextResponse.json({ ok: false, error: "Cliente no encontrado" }, { status: 404 });
    }

    const body = bodySchema.parse(await request.json());
    const extraction = (client.extractionConfigJson ?? {}) as Record<string, unknown>;
    extraction.debugMode = body.debugMode;

    await prisma.client.update({
      where: { id },
      data: {
        extractionConfigJson: extraction as Prisma.InputJsonValue,
      },
    });

    return NextResponse.json({ ok: true, debugMode: body.debugMode });
  } catch (err) {
    const message =
      err instanceof z.ZodError
        ? err.issues.map((i) => i.message).join(", ")
        : err instanceof Error
          ? err.message
          : "Error al actualizar";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
