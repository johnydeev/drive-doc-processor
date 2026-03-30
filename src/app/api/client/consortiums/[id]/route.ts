import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedSession } from "@/lib/adminAuth";
import { requireClientSession } from "@/lib/clientAuth";
import { ConsortiumRepository } from "@/repositories/consortium.repository";
import { InvoiceRepository } from "@/repositories/invoice.repository";
import { getPrismaClient } from "@/lib/prisma";

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
      include: { periods: true },
    });

    if (!consortium) {
      return NextResponse.json(
        { ok: false, error: "Consortium not found" },
        { status: 404 }
      );
    }

    const consortiumRepo = new ConsortiumRepository();
    const activePeriod = await consortiumRepo.findActivePeriod(consortium.id);

    const invoiceRepo = new InvoiceRepository();
    const invoices = activePeriod ? await invoiceRepo.findByPeriod(activePeriod.id) : [];

    return NextResponse.json({
      ok: true,
      consortium,
      activePeriod,
      invoices,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}

export async function PATCH(
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

    const data: Record<string, unknown> = {};
    if (typeof body.matchNames === "string" || body.matchNames === null) {
      data.matchNames = body.matchNames || null;
    }

    const updated = await prisma.consortium.update({
      where: { id: consortiumId },
      data,
    });

    return NextResponse.json({ ok: true, consortium: updated });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
