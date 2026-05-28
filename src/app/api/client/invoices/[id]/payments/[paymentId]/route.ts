import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { requireClientSession } from "@/lib/clientAuth";
import { getPrismaClient } from "@/lib/prisma";
import { PaymentError } from "@/repositories/payment.repository";
import { GoogleDriveService } from "@/services/googleDrive.service";
import { GoogleSheetsService, SheetsRowMapping } from "@/services/googleSheets.service";
import { resolveGoogleConfig, resolveMapping, resolveSheetName } from "@/lib/clientProcessingConfig";
import { ClientDriveFolders, ClientGoogleConfig, ProcessingClient } from "@/types/client.types";

const DEFAULT_MAPPING: SheetsRowMapping = {
  boletaNumber: "A",
  provider: "B",
  consortium: "C",
  providerTaxId: "D",
  detail: "E",
  observation: "F",
  dueDate: "G",
  amount: "H",
  alias: "I",
  clientNumber: "J",
  sourceFileUrl: "K",
  isDuplicate: "L",
  period: "M",
  paymentStatus: "N",
  bank: "O",
  remainingBalance: "P",
  paidAmount: "Q",
  installmentsCount: "R",
  paymentDate: "S",
  receiptUrl: "T",
  paidWith: "U",
};

/**
 * DELETE /api/client/invoices/[id]/payments/[paymentId]
 *
 * Elimina un pago. Efectos:
 *   1. Valida que el pago pertenece al cliente y es el último de la boleta
 *      (restricción del PaymentRepository: solo se borra el más reciente).
 *   2. Si el pago tiene comprobante en Drive (`driveFileId`), lo manda a la papelera.
 *   3. Recalcula `remainingBalance` e `isPaid` de la boleta.
 *   4. Actualiza las columnas N/P/Q/R/S/T/U en Sheets:
 *        - Si quedan otros pagos → escribe el resumen del más reciente.
 *        - Si no quedan → limpia las 5 celdas y vuelve estado a "Impago".
 *   5. Borra el Payment de la DB.
 *
 * Orden: Drive → Sheets → DB. Si Drive o Sheets fallan, se aborta antes de
 * tocar la DB (no quedan inconsistencias mayores; el payment sigue existiendo).
 *
 * NO se revierte el `periodId` de la invoice si había sido reasignado al mes
 * siguiente por pago parcial — esto se mantiene como deuda del periodo nuevo.
 */
export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string; paymentId: string }> }
) {
  const auth = requireClientSession(request);
  if (auth.error) return auth.error;

  const { id: invoiceId, paymentId } = await context.params;
  const clientId = auth.session.clientId;

  try {
    const prisma = getPrismaClient();

    // ── 1. Validaciones y carga de datos ──────────────────────────────────
    const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) {
      return NextResponse.json({ ok: false, error: "Pago no encontrado" }, { status: 404 });
    }
    if (payment.clientId !== clientId) {
      return NextResponse.json({ ok: false, error: "El pago no pertenece al cliente" }, { status: 403 });
    }
    if (payment.invoiceId !== invoiceId) {
      return NextResponse.json({ ok: false, error: "El pago no corresponde a la boleta" }, { status: 400 });
    }

    // Mismo check que el PaymentRepository: solo se puede borrar el último.
    const allPayments = await prisma.payment.findMany({
      where: { invoiceId },
      orderBy: { createdAt: "desc" },
    });
    if (allPayments.length === 0 || allPayments[0].id !== paymentId) {
      return NextResponse.json(
        { ok: false, error: "Solo se puede eliminar el último pago registrado" },
        { status: 409 }
      );
    }

    const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) {
      return NextResponse.json({ ok: false, error: "Boleta no encontrada" }, { status: 404 });
    }

    // ── 2. Resolver config Google ─────────────────────────────────────────
    const clientRow = await prisma.client.findUnique({
      where: { id: clientId },
      select: { driveFoldersJson: true, googleConfigJson: true, extractionConfigJson: true },
    });
    if (!clientRow) {
      return NextResponse.json({ ok: false, error: "Cliente no encontrado" }, { status: 404 });
    }
    const processingClient: ProcessingClient = {
      id: clientId,
      name: "",
      isActive: true,
      batchSize: 10,
      intervalMinutes: 60,
      driveFoldersJson: (clientRow.driveFoldersJson as ClientDriveFolders | null) ?? null,
      googleConfigJson: (clientRow.googleConfigJson as ClientGoogleConfig | null) ?? null,
      extractionConfigJson: (clientRow.extractionConfigJson as Record<string, unknown> | null) ?? null,
    };
    const googleConfig = resolveGoogleConfig(processingClient);

    // ── 3. Borrar comprobante de Drive (si existe) ────────────────────────
    if (payment.driveFileId && googleConfig) {
      try {
        const driveService = new GoogleDriveService(googleConfig);
        await driveService.trashFile(payment.driveFileId);
      } catch (err) {
        return NextResponse.json(
          {
            ok: false,
            error: `Drive falló al borrar el comprobante: ${err instanceof Error ? err.message : "Error"}`,
          },
          { status: 502 }
        );
      }
    }

    // ── 4. Calcular nuevos valores de invoice (sin tocar DB todavía) ──────
    const remainingAfter = allPayments
      .slice(1) // saltar el que se va a borrar
      .reduce((acc, p) => acc.plus(new Prisma.Decimal(p.amount.toString())), new Prisma.Decimal(0));
    const invoiceAmount = invoice.amount ? new Prisma.Decimal(invoice.amount.toString()) : new Prisma.Decimal(0);
    const newRemaining = invoiceAmount.minus(remainingAfter);
    const willStillHavePayments = allPayments.length > 1;
    const prevPayment = willStillHavePayments ? allPayments[1] : null;

    // ── 5. Actualizar Sheets ──────────────────────────────────────────────
    if (googleConfig) {
      try {
        const sheetName = resolveSheetName(processingClient);
        const mapping = resolveMapping(processingClient) ?? DEFAULT_MAPPING;
        const sheetsService = new GoogleSheetsService(googleConfig);

        if (willStillHavePayments && prevPayment) {
          // Quedan otros pagos: escribir el resumen del más reciente que queda.
          await sheetsService.updateInvoicePaymentInfo(
            sheetName,
            mapping,
            {
              boletaNumber: invoice.boletaNumber,
              sourceFileUrl: invoice.sourceFileUrl,
              providerTaxId: invoice.providerTaxId,
            },
            {
              paymentStatus: newRemaining.equals(0) ? "Pagado" : "Pago parcial",
              remainingBalance: newRemaining.equals(0) ? 0 : Number(newRemaining.toFixed(2)),
              paidAmount: Number(remainingAfter.toFixed(2)),
              paymentDate: formatDateAR(prevPayment.paymentDate),
              receiptUrl: prevPayment.driveFileUrl ?? "",
              paidWith: prevPayment.paymentMethod ?? "",
              installmentsCount: prevPayment.installmentNumber ? String(prevPayment.installmentNumber) : "",
            }
          );
        } else {
          // No quedan pagos: limpiar todo y dejar estado "Impago".
          await sheetsService.updateInvoicePaymentInfo(
            sheetName,
            mapping,
            {
              boletaNumber: invoice.boletaNumber,
              sourceFileUrl: invoice.sourceFileUrl,
              providerTaxId: invoice.providerTaxId,
            },
            {
              paymentStatus: "Impago",
              remainingBalance: null,
              paidAmount: null,
              paymentDate: "",
              receiptUrl: "",
              paidWith: "",
              installmentsCount: "",
            }
          );
        }
      } catch (err) {
        return NextResponse.json(
          {
            ok: false,
            error: `Sheets falló al actualizar: ${err instanceof Error ? err.message : "Error"}`,
          },
          { status: 502 }
        );
      }
    }

    // ── 6. Borrar payment de DB + recalcular invoice ──────────────────────
    await prisma.$transaction(async (tx) => {
      await tx.payment.delete({ where: { id: paymentId } });
      await tx.invoice.update({
        where: { id: invoiceId },
        data: willStillHavePayments
          ? { isPaid: newRemaining.equals(0), remainingBalance: newRemaining }
          : { isPaid: false, remainingBalance: null },
      });
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof PaymentError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: err.statusCode });
    }
    console.error("[payment-delete]", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Error interno" },
      { status: 500 }
    );
  }
}

function formatDateAR(d: Date): string {
  return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
}
