import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { requireClientSession } from "@/lib/clientAuth";
import { getPrismaClient } from "@/lib/prisma";
import {
  PaymentRepository,
  PaymentError,
} from "@/repositories/payment.repository";
import { GoogleSheetsService, SheetsRowMapping } from "@/services/googleSheets.service";
import { GoogleDriveService } from "@/services/googleDrive.service";
import { resolveGoogleConfig, resolveMapping, resolveSheetName, resolveFolders } from "@/lib/clientProcessingConfig";
import { ClientDriveFolders, ClientGoogleConfig, ProcessingClient } from "@/types/client.types";
import { isPdf } from "@/lib/fileSignature";

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

const MONTH_NAMES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

const MAX_RECEIPT_SIZE = 20 * 1024 * 1024; // 20MB

const createPaymentSchema = z.object({
  amount: z.number().positive("El monto debe ser positivo"),
  paymentDate: z.string().refine((v) => !isNaN(Date.parse(v)), "Fecha inválida"),
  totalInstallments: z.number().int().min(2).optional(),
  driveFileId: z.string().optional().nullable(),
  driveFileUrl: z.string().optional().nullable(),
  paymentMethod: z.string().optional().nullable(),
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

/**
 * POST /api/client/invoices/[id]/payments
 *
 * Acepta dos content-types:
 * - `application/json` (compatibilidad con UI legacy / scripts): body con los campos
 *   del schema; no se sube archivo.
 * - `multipart/form-data` (modal nuevo): campos como form fields + archivo opcional
 *   en el campo "receipt" (PDF, máx 20MB) que se sube a Drive.
 *
 * Flujo:
 * 1. Parsea body según content-type.
 * 2. Si hay archivo: lo sube a Drive (carpeta receipts/consorcio/período).
 * 3. Crea Payment via PaymentRepository (maneja modo cuotas vs libre, isPaid,
 *    remainingBalance).
 * 4. Si queda saldo y la boleta tiene período, reasigna periodId al mes siguiente
 *    (crea período ACTIVE si no existe).
 * 5. Actualiza las columnas N (ESTADO PAGO), P (SALDO PENDIENTE), Q (MONTO PAGADO),
 *    R (CANT CUOTAS), S (FECHA PAGO), T (URL COMPROBANTE) y M (PERIODO) — solo las
 *    que correspondan — en la fila de la boleta en Sheets.
 *
 * Tolerante a errores de Sheets: si el update de Sheets falla, el Payment ya quedó
 * persistido en DB y se loguea warning.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const auth = requireClientSession(request);
  if (auth.error) return auth.error;

  const { id: invoiceId } = await context.params;
  const clientId = auth.session.clientId;

  try {
    const contentType = request.headers.get("content-type") ?? "";
    const isMultipart = contentType.toLowerCase().includes("multipart/form-data");

    // ── Parsear inputs ─────────────────────────────────────────────────────
    let amount: number;
    let paymentDate: string;
    let totalInstallments: number | undefined;
    let paymentMethod: string | null;
    let observation: string | undefined;
    let driveFileId: string | null = null;
    let driveFileUrl: string | null = null;
    let receiptFile: File | null = null;

    if (isMultipart) {
      const form = await request.formData();
      const amountRaw = (form.get("amount") ?? "").toString().trim();
      amount = Number(amountRaw);
      paymentDate = (form.get("paymentDate") ?? "").toString().trim();
      const instRaw = (form.get("totalInstallments") ?? "").toString().trim();
      totalInstallments = instRaw ? Number(instRaw) : undefined;
      paymentMethod = (form.get("paymentMethod") ?? "").toString().trim() || null;
      observation = (form.get("observation") ?? "").toString().trim() || undefined;
      const file = form.get("receipt");
      if (file instanceof File && file.size > 0) receiptFile = file;

      if (!Number.isFinite(amount) || amount <= 0) {
        return NextResponse.json({ ok: false, error: "El monto debe ser positivo" }, { status: 400 });
      }
      if (!paymentDate || Number.isNaN(Date.parse(paymentDate))) {
        return NextResponse.json({ ok: false, error: "Fecha inválida" }, { status: 400 });
      }
      if (totalInstallments !== undefined && (!Number.isInteger(totalInstallments) || totalInstallments < 2)) {
        return NextResponse.json({ ok: false, error: "Las cuotas deben ser un entero >= 2" }, { status: 400 });
      }
    } else {
      const body = await request.json();
      const parsed = createPaymentSchema.safeParse(body);
      if (!parsed.success) {
        return NextResponse.json({ ok: false, error: parsed.error.issues[0].message }, { status: 400 });
      }
      amount = parsed.data.amount;
      paymentDate = parsed.data.paymentDate;
      totalInstallments = parsed.data.totalInstallments;
      paymentMethod = parsed.data.paymentMethod ?? null;
      observation = parsed.data.observation;
      driveFileId = parsed.data.driveFileId ?? null;
      driveFileUrl = parsed.data.driveFileUrl ?? null;
    }

    const prisma = getPrismaClient();

    // ── Cargar invoice + cliente (para Drive/Sheets) ──────────────────────
    const invoice = await prisma.invoice.findFirst({
      where: { id: invoiceId, clientId },
      include: {
        consortiumRef: { select: { rawName: true } },
        periodRef: { select: { year: true, month: true } },
      },
    });
    if (!invoice) {
      return NextResponse.json({ ok: false, error: "Boleta no encontrada" }, { status: 404 });
    }

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

    // ── Subir PDF a Drive si vino ──────────────────────────────────────────
    if (receiptFile && googleConfig) {
      if (receiptFile.type !== "application/pdf") {
        return NextResponse.json({ ok: false, error: "Solo se aceptan archivos PDF" }, { status: 400 });
      }
      if (receiptFile.size > MAX_RECEIPT_SIZE) {
        return NextResponse.json({ ok: false, error: "El comprobante no puede superar 20MB" }, { status: 400 });
      }

      const buffer = Buffer.from(await receiptFile.arrayBuffer());
      if (!isPdf(buffer)) {
        return NextResponse.json(
          { ok: false, error: "El archivo no es un PDF válido (firma binaria incorrecta)" },
          { status: 400 }
        );
      }

      const folders = resolveFolders(processingClient);
      const rootReceiptsFolderId = folders.receipts ?? folders.scanned;
      if (!rootReceiptsFolderId) {
        return NextResponse.json(
          { ok: false, error: "Sin carpeta de destino configurada en Drive" },
          { status: 400 }
        );
      }

      const driveService = new GoogleDriveService(googleConfig);
      const consortiumName = invoice.consortiumRef?.rawName ?? invoice.consortium ?? "Sin Consorcio";
      const periodLabel = invoice.periodRef
        ? `${MONTH_NAMES[invoice.periodRef.month - 1]} ${invoice.periodRef.year}`
        : "Sin Período";

      const consortiumFolderId = await driveService.getOrCreateFolder(consortiumName, rootReceiptsFolderId);
      const periodFolderId = await driveService.getOrCreateFolder(periodLabel, consortiumFolderId);

      const uploaded = await driveService.uploadFile(
        buffer,
        receiptFile.name || `recibo_${invoiceId}.pdf`,
        "application/pdf",
        periodFolderId
      );
      if (!uploaded.id) {
        return NextResponse.json({ ok: false, error: "Error al subir el comprobante a Drive" }, { status: 500 });
      }
      driveFileId = uploaded.id;
      driveFileUrl = uploaded.webViewLink ?? `https://drive.google.com/file/d/${uploaded.id}/view`;
    }

    // ── Crear Payment (PaymentRepository maneja isPaid / remainingBalance) ─
    const repo = new PaymentRepository();
    const result = await repo.createPayment({
      clientId,
      invoiceId,
      amount,
      paymentDate: new Date(paymentDate),
      totalInstallments,
      driveFileId,
      driveFileUrl,
      paymentMethod,
      observation,
    });

    // ── Reasignar periodId al mes siguiente si quedó saldo + obtener totales ─
    const postOp = await postPaymentBookkeeping(prisma, invoiceId);

    // ── Reflejar en Sheets ─────────────────────────────────────────────────
    if (googleConfig && postOp) {
      const sheetName = resolveSheetName(processingClient);
      const mapping = resolveMapping(processingClient) ?? DEFAULT_MAPPING;
      const sheetsService = new GoogleSheetsService(googleConfig);

      try {
        await sheetsService.updateInvoicePaymentInfo(
          sheetName,
          mapping,
          {
            boletaNumber: result.invoice.boletaNumber,
            sourceFileUrl: result.invoice.sourceFileUrl,
            providerTaxId: result.invoice.providerTaxId,
          },
          {
            paymentStatus: postOp.isPaid ? "Pagado" : "Pago parcial",
            remainingBalance: postOp.isPaid ? 0 : postOp.remainingBalance,
            paidAmount: postOp.paidAmount,
            installmentsCount: totalInstallments ? String(totalInstallments) : null,
            paymentDate: formatDateAR(new Date(paymentDate)),
            receiptUrl: driveFileUrl ?? null,
            paidWith: paymentMethod,
            ...(postOp.newPeriodLabel ? { period: postOp.newPeriodLabel } : {}),
          }
        );
      } catch (sheetsError) {
        console.warn(
          `[payments-post] sheets update falló invoiceId=${invoiceId}: ${
            sheetsError instanceof Error ? sheetsError.message : "Unknown error"
          }`
        );
      }
    }

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

/**
 * Tras crear un Payment, si la invoice quedó con saldo y tiene período asignado:
 * busca/crea el período del mes siguiente del mismo consorcio y reasigna periodId.
 * Retorna también el total acumulado pagado para escribirlo en Sheets.
 */
async function postPaymentBookkeeping(
  prisma: ReturnType<typeof getPrismaClient>,
  invoiceId: string
): Promise<{
  isPaid: boolean;
  remainingBalance: number;
  paidAmount: number;
  newPeriodLabel: string | null;
} | null> {
  return prisma.$transaction(async (tx) => {
    const invoice = await tx.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        payments: { select: { amount: true } },
        periodRef: { select: { year: true, month: true } },
      },
    });
    if (!invoice || invoice.amount === null) return null;

    const total = invoice.payments.reduce(
      (acc, p) => acc.plus(new Prisma.Decimal(p.amount.toString())),
      new Prisma.Decimal(0)
    );
    const invoiceAmount = new Prisma.Decimal(invoice.amount.toString());
    let remaining = invoiceAmount.minus(total);
    if (remaining.lessThanOrEqualTo(0)) remaining = new Prisma.Decimal(0);
    const isPaid = remaining.equals(0);

    let newPeriodLabel: string | null = null;

    if (!isPaid && remaining.greaterThan(0) && invoice.consortiumId && invoice.periodRef) {
      const nextMonth = invoice.periodRef.month === 12 ? 1 : invoice.periodRef.month + 1;
      const nextYear = invoice.periodRef.month === 12 ? invoice.periodRef.year + 1 : invoice.periodRef.year;

      const isAlreadyInNext =
        invoice.periodRef.year === nextYear && invoice.periodRef.month === nextMonth;

      if (!isAlreadyInNext) {
        let nextPeriod = await tx.period.findUnique({
          where: {
            consortiumId_year_month: {
              consortiumId: invoice.consortiumId,
              year: nextYear,
              month: nextMonth,
            },
          },
        });

        if (!nextPeriod) {
          nextPeriod = await tx.period.create({
            data: {
              clientId: invoice.clientId,
              consortiumId: invoice.consortiumId,
              year: nextYear,
              month: nextMonth,
              status: "ACTIVE",
            },
          });
        }

        await tx.invoice.update({
          where: { id: invoiceId },
          data: { periodId: nextPeriod.id },
        });

        newPeriodLabel = `${String(nextMonth).padStart(2, "0")}/${nextYear}`;
      }
    }

    return {
      isPaid,
      remainingBalance: Number(remaining.toFixed(2)),
      paidAmount: Number(total.toFixed(2)),
      newPeriodLabel,
    };
  });
}

function formatDateAR(d: Date): string {
  return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
}
