import { NextRequest, NextResponse } from "next/server";
import { requireClientSession } from "@/lib/clientAuth";
import {
  PaymentRepository,
  PaymentError,
} from "@/repositories/payment.repository";

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string; paymentId: string }> }
) {
  const auth = requireClientSession(request);
  if (auth.error) return auth.error;

  const { paymentId } = await context.params;
  const clientId = auth.session.clientId;

  try {
    const repo = new PaymentRepository();
    await repo.deletePayment(paymentId, clientId);

    return NextResponse.json({ ok: true, success: true });
  } catch (err) {
    if (err instanceof PaymentError) {
      return NextResponse.json(
        { ok: false, error: err.message },
        { status: err.statusCode }
      );
    }

    console.error("[payments-delete]", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Error interno" },
      { status: 500 }
    );
  }
}
