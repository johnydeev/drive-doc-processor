import { NextRequest, NextResponse } from "next/server";
import { requireClientSession } from "@/lib/clientAuth";
import { requireAuthenticatedSession } from "@/lib/adminAuth";
import { getPrismaClient } from "@/lib/prisma";

const VALID_PROVIDERS = [
  "EDESUR", "AYSA", "EDENOR", "METROGAS",
  "NATURGY", "CAMUZZI", "LITORAL_GAS", "PERSONAL",
] as const;

function stripLeadingZeros(value: string): string {
  return value.replace(/\b0+(\d+)\b/g, "$1");
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const auth = requireAuthenticatedSession(request);
  if (auth.error) {
    return auth.error;
  }

  const { id: consortiumId } = await context.params;

  try {
    const prisma = getPrismaClient();

    const consortium = await prisma.consortium.findFirst({
      where: { id: consortiumId, clientId: auth.session.clientId },
    });

    if (!consortium) {
      return NextResponse.json(
        { ok: false, error: "Consortium not found" },
        { status: 404 }
      );
    }

    const lspServices = await prisma.lspService.findMany({
      where: { consortiumId, clientId: auth.session.clientId },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json({ ok: true, lspServices });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const auth = requireClientSession(request);
  if (auth.error) {
    return auth.error;
  }

  const { id: consortiumId } = await context.params;

  try {
    const body = await request.json();
    const { provider, clientNumber, description } = body;

    if (!provider || !VALID_PROVIDERS.includes(provider)) {
      return NextResponse.json(
        { ok: false, error: `Proveedor inválido. Valores permitidos: ${VALID_PROVIDERS.join(", ")}` },
        { status: 400 }
      );
    }

    if (!clientNumber || typeof clientNumber !== "string" || !clientNumber.trim()) {
      return NextResponse.json(
        { ok: false, error: "El número de cliente es obligatorio" },
        { status: 400 }
      );
    }

    const prisma = getPrismaClient();

    const consortium = await prisma.consortium.findFirst({
      where: { id: consortiumId, clientId: auth.session.clientId },
    });

    if (!consortium) {
      return NextResponse.json(
        { ok: false, error: "Consortium not found" },
        { status: 404 }
      );
    }

    const normalizedClientNumber = stripLeadingZeros(clientNumber.trim().replace(/\s+/g, ""));

    const existing = await prisma.lspService.findFirst({
      where: { consortiumId, providerName: provider, clientNumber: normalizedClientNumber },
    });

    if (existing) {
      return NextResponse.json(
        { ok: false, error: "Ya existe un servicio con ese número de cliente para esta empresa" },
        { status: 409 }
      );
    }

    const lspService = await prisma.lspService.create({
      data: {
        clientId: auth.session.clientId,
        consortiumId,
        providerName: provider,
        clientNumber: normalizedClientNumber,
        description: description?.trim() || null,
      },
    });

    return NextResponse.json({ ok: true, lspService }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
