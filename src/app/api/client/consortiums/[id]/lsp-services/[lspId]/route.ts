import { NextRequest, NextResponse } from "next/server";
import { requireClientSession } from "@/lib/clientAuth";
import { getPrismaClient } from "@/lib/prisma";

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string; lspId: string }> }
) {
  const auth = requireClientSession(request);
  if (auth.error) {
    return auth.error;
  }

  const { id: consortiumId, lspId } = await context.params;

  try {
    const prisma = getPrismaClient();

    const lspService = await prisma.lspService.findFirst({
      where: {
        id: lspId,
        consortiumId,
        clientId: auth.session.clientId,
      },
    });

    if (!lspService) {
      return NextResponse.json(
        { ok: false, error: "LspService not found" },
        { status: 404 }
      );
    }

    await prisma.lspService.delete({ where: { id: lspId } });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
