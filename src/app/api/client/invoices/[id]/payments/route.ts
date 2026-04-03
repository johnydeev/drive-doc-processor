import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireClientSession } from "@/lib/clientAuth";
import { getPrismaClient } from "@/lib/prisma";
import {
  PaymentRepository,
  PaymentError,
} from "@/repositories/payment.repository";

const createPaymentSchema = z.object({
  amount: z.number().positive("El monto debe ser positivo"),
  paymentDate: z.string().refine((v) => !isNaN(Date.parse(v)), "Fecha inválida"),
  totalInstallments: z.number().int().min(2).optional(),
  driveFileId: z.string().min(1, "driveFileId es requerido"),
  driveFileUrl: z.string().min(1, "driveFileUrl es requerido"),
  observation: z.string().optional(),
});

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const auth = requireClientSession(request);
  if (auth.error) return auth.error;

  const { id: invoiceId } = await context.params;
  const clientId = auth.session.clientId;

  try {
    const prisma = getPrismaClient();

    const invoice = await prisma.invoice.findFirst({
      where: { id: invoiceId, clientId },
      select: { id: true, isPaid: true, remainingBalance: true, amount: true },
    });

    if (!invoice) {
      return NextResponse.json(
        { ok: false, error: "Boleta no encontrada" },
        { status: 404 }
      );
    }

    const repo = new PaymentRepository();
    const payments = await repo.getPaymentsByInvoiceId(invoiceId, clientId);

    return NextResponse.json({
      ok: true,
      payments,
      invoice: {
        isPaid: invoice.isPaid,
        remainingBalance: invoice.remainingBalance,
        amount: invoice.amount,
      },
    });
  } catch (err) {
    console.error("[payments-get]", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Error interno" },
      { status: 500 }
    );
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const auth = requireClientSession(request);
  if (auth.error) return auth.error;

  const { id: invoiceId } = await context.params;
  const clientId = auth.session.clientId;

  try {
    const body = await request.json();
    const parsed = createPaymentSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    const repo = new PaymentRepository();
    const result = await repo.createPayment({
      clientId,
      invoiceId,
      amount: parsed.data.amount,
      paymentDate: new Date(parsed.data.paymentDate),
      totalInstallments: parsed.data.totalInstallments,
      driveFileId: parsed.data.driveFileId,
      driveFileUrl: parsed.data.driveFileUrl,
      observation: parsed.data.observation,
    });

    return NextResponse.json(
      { ok: true, payment: result.payment, invoice: result.invoice },
      { status: 201 }
    );
  } catch (err) {
    if (err instanceof PaymentError) {
      return NextResponse.json(
        { ok: false, error: err.message },
        { status: err.statusCode }
      );
    }

    const message = err instanceof Error ? err.message : "Error interno";
    const isPrismaNotFound =
      err instanceof Error && err.message.includes("P2025");

    console.error("[payments-post]", message);
    return NextResponse.json(
      { ok: false, error: isPrismaNotFound ? "Boleta no encontrada" : message },
      { status: isPrismaNotFound ? 404 : 500 }
    );
  }
}
