import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireClientSession } from "@/lib/clientAuth";
import { getPrismaClient } from "@/lib/prisma";
import {
  PaymentRepository,
  PaymentError,
} from "@/repositories/payment.repository";
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
};

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
      driveFileId: parsed.data.driveFileId ?? null,
      driveFileUrl: parsed.data.driveFileUrl ?? null,
      paymentMethod: parsed.data.paymentMethod ?? null,
      observation: parsed.data.observation,
    });

    // Sincronizar ESTADO PAGO en Google Sheets si la boleta quedó pagada
    if (result.invoice.isPaid) {
      try {
        const prisma = getPrismaClient();
        const clientRow = await prisma.client.findUnique({
          where: { id: clientId },
          select: { driveFoldersJson: true, googleConfigJson: true, extractionConfigJson: true },
        });
        if (clientRow) {
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
          const sheetName = resolveSheetName(processingClient);
          const mapping = resolveMapping(processingClient) ?? DEFAULT_MAPPING;
          if (googleConfig) {
            const sheetsService = new GoogleSheetsService(googleConfig);
            await sheetsService.updatePaymentStatus(
              sheetName,
              mapping,
              {
                boletaNumber: result.invoice.boletaNumber,
                sourceFileUrl: result.invoice.sourceFileUrl,
                providerTaxId: result.invoice.providerTaxId,
              },
              "Pagado"
            );
          }
        }
      } catch (sheetsError) {
        console.warn(
          `[payments-post] sheets updatePaymentStatus failed invoiceId=${invoiceId}: ${
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
