import { Prisma } from "@prisma/client";
import { getPrismaClient } from "@/lib/prisma";
import {
  GoogleSheetsService,
  SheetsRowMapping,
} from "@/services/googleSheets.service";
import {
  resolveGoogleConfig,
  resolveMapping,
  resolveSheetName,
} from "@/lib/clientProcessingConfig";
import { ClientDriveFolders, ClientGoogleConfig, ProcessingClient } from "@/types/client.types";
import { normalizeBusinessAmount } from "@/lib/businessKey";

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

export interface SyncInvoicePaymentsResult {
  paymentsCreated: number;
  paymentsUpdated: number;
  rowsSkipped: number;
  invoicesAffected: number;
  sheetsUpdated: number;
  sheetsFailed: number;
  warnings: string[];
  syncedAt: Date;
}

export class SyncPaymentsError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
    this.name = "SyncPaymentsError";
  }
}

/** Convierte "07/04/2026" o "2026-04-07" o "7/4/26" a Date, o null si no parsea */
function parsePaymentDate(raw: string): Date | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(trimmed);
  if (iso) {
    const d = new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const ar = /^(\d{1,2})[/\-](\d{1,2})[/\-](\d{2,4})$/.exec(trimmed);
  if (ar) {
    let year = Number(ar[3]);
    if (year < 100) year += 2000;
    const d = new Date(Date.UTC(year, Number(ar[2]) - 1, Number(ar[1])));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const t = Date.parse(trimmed);
  return Number.isFinite(t) ? new Date(t) : null;
}

function isoDayKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate()
  ).padStart(2, "0")}`;
}

type InvoiceLite = {
  id: string;
  boletaNumber: string | null;
  boletaNumberNorm: string;
  sourceFileUrl: string | null;
  providerTaxId: string | null;
  amount: Prisma.Decimal | null;
  periodId: string | null;
  consortiumId: string | null;
  payments: Array<{
    id: string;
    amount: Prisma.Decimal;
    paymentDate: Date;
    observation: string | null;
    driveFileUrl: string | null;
    paymentMethod: string | null;
  }>;
};

function matchInvoiceFromRow(
  row: { boletaNumber: string | null; sourceFileUrl: string | null },
  byUrl: Map<string, InvoiceLite>,
  byBoleta: Map<string, InvoiceLite>
): InvoiceLite | null {
  if (row.sourceFileUrl) {
    const hit = byUrl.get(row.sourceFileUrl.trim());
    if (hit) return hit;
  }
  if (row.boletaNumber) {
    const norm = row.boletaNumber.toLowerCase().trim();
    const hit = byBoleta.get(norm);
    if (hit) return hit;
  }
  return null;
}

async function recalculateInvoicePayment(
  prisma: ReturnType<typeof getPrismaClient>,
  invoiceId: string
) {
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
    let newPeriodId: string | undefined;

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

        newPeriodId = nextPeriod.id;
        newPeriodLabel = `${String(nextMonth).padStart(2, "0")}/${nextYear}`;
      }
    }

    await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        isPaid,
        remainingBalance: remaining,
        ...(newPeriodId ? { periodId: newPeriodId } : {}),
      },
    });

    return {
      invoiceId,
      isPaid,
      remainingBalance: Number(remaining.toFixed(2)),
      newPeriodLabel,
      boletaNumber: invoice.boletaNumber,
      sourceFileUrl: invoice.sourceFileUrl,
      providerTaxId: invoice.providerTaxId,
    };
  });
}

/**
 * Sincroniza los pagos cargados manualmente en las columnas Q/R/S/T/U de la
 * hoja de boletas con la tabla Payment de la DB.
 *
 * Reusable desde el endpoint /api/client/sync-payments y desde
 * /api/client/setup-sheet-protection (auto-sync antes de re-proteger).
 *
 * @throws SyncPaymentsError con statusCode si falla precondición (cliente, credenciales).
 */
export async function syncInvoicePaymentsFromSheets(
  clientId: string
): Promise<SyncInvoicePaymentsResult> {
  const startTime = Date.now();
  console.log(`[sync-payments] Iniciando — clientId=${clientId}`);

  const prisma = getPrismaClient();

  const client = await prisma.client.findUnique({ where: { id: clientId } });
  if (!client) {
    throw new SyncPaymentsError("Cliente no encontrado", 404);
  }

  const processingClient: ProcessingClient = {
    id: clientId,
    name: client.name,
    isActive: client.isActive,
    batchSize: client.batchSize,
    intervalMinutes: client.intervalMinutes,
    driveFoldersJson: (client.driveFoldersJson as ClientDriveFolders | null) ?? null,
    googleConfigJson: (client.googleConfigJson as ClientGoogleConfig | null) ?? null,
    extractionConfigJson: (client.extractionConfigJson as Record<string, unknown> | null) ?? null,
  };

  const googleConfig = resolveGoogleConfig(processingClient);
  if (!googleConfig) {
    throw new SyncPaymentsError("Credenciales de Google incompletas", 400);
  }

  const sheetName = resolveSheetName(processingClient);
  const mapping = resolveMapping(processingClient) ?? DEFAULT_MAPPING;
  const sheetsService = new GoogleSheetsService(googleConfig);

  // 1. Leer filas con pago cargado
  const paymentRows = await sheetsService.readInvoicePaymentRows(sheetName, mapping);
  console.log(`[sync-payments] Filas con pago en Sheets: ${paymentRows.length}`);

  // 2. Cargar invoices con sus payments
  const invoices = await prisma.invoice.findMany({
    where: { clientId },
    select: {
      id: true,
      boletaNumber: true,
      boletaNumberNorm: true,
      sourceFileUrl: true,
      providerTaxId: true,
      amount: true,
      periodId: true,
      consortiumId: true,
      payments: {
        select: {
          id: true,
          amount: true,
          paymentDate: true,
          observation: true,
          driveFileUrl: true,
          paymentMethod: true,
        },
      },
    },
  });

  const invoiceByUrl = new Map<string, (typeof invoices)[number]>();
  const invoiceByBoleta = new Map<string, (typeof invoices)[number]>();
  for (const inv of invoices) {
    if (inv.sourceFileUrl) invoiceByUrl.set(inv.sourceFileUrl.trim(), inv);
    if (inv.boletaNumberNorm && !invoiceByBoleta.has(inv.boletaNumberNorm)) {
      invoiceByBoleta.set(inv.boletaNumberNorm, inv);
    }
  }

  const warnings: string[] = [];
  const affectedInvoiceIds = new Set<string>();
  let paymentsCreated = 0;
  let paymentsUpdated = 0;
  let rowsSkipped = 0;

  // 3. Procesar cada fila (upsert idempotente)
  for (const row of paymentRows) {
    const matchedInvoice = matchInvoiceFromRow(row, invoiceByUrl, invoiceByBoleta);

    if (!matchedInvoice) {
      warnings.push(
        `Fila ${row.rowNumber}: no se encontró Invoice (sourceFileUrl="${row.sourceFileUrl ?? ""}" / boleta="${row.boletaNumber ?? ""}")`
      );
      rowsSkipped++;
      continue;
    }

    const paymentDate = parsePaymentDate(row.paymentDate!);
    if (!paymentDate) {
      warnings.push(`Fila ${row.rowNumber}: FECHA PAGO "${row.paymentDate}" inválida`);
      rowsSkipped++;
      continue;
    }

    const amountNum = Number(normalizeBusinessAmount(row.paidAmount!));
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      warnings.push(`Fila ${row.rowNumber}: MONTO PAGADO "${row.paidAmount}" inválido`);
      rowsSkipped++;
      continue;
    }

    const installments = row.installmentsCount
      ? Number(row.installmentsCount.replace(/\D/g, ""))
      : null;
    const totalInstallments = installments && installments > 1 ? installments : null;

    const naturalKey = `${matchedInvoice.id}|${isoDayKey(paymentDate)}|${amountNum.toFixed(2)}`;

    const existingPayment = matchedInvoice.payments.find((p) => {
      const pAmount = Number(p.amount.toString());
      const pKey = `${matchedInvoice.id}|${isoDayKey(p.paymentDate)}|${pAmount.toFixed(2)}`;
      return pKey === naturalKey;
    });

    if (existingPayment) {
      const needsUpdate =
        existingPayment.driveFileUrl !== (row.receiptUrl ?? null) ||
        existingPayment.paymentMethod !== (row.paidWith ?? null);

      if (needsUpdate) {
        await prisma.payment.update({
          where: { id: existingPayment.id },
          data: {
            driveFileUrl: row.receiptUrl ?? null,
            paymentMethod: row.paidWith ?? null,
          },
        });
        paymentsUpdated++;
        affectedInvoiceIds.add(matchedInvoice.id);
      }
      continue;
    }

    await prisma.payment.create({
      data: {
        clientId,
        invoiceId: matchedInvoice.id,
        amount: new Prisma.Decimal(amountNum.toFixed(2)),
        paymentDate,
        totalInstallments,
        driveFileUrl: row.receiptUrl ?? null,
        paymentMethod: row.paidWith ?? null,
        observation: "Cargado desde Sheets",
      },
    });
    paymentsCreated++;
    affectedInvoiceIds.add(matchedInvoice.id);
  }

  console.log(
    `[sync-payments] Pagos creados=${paymentsCreated} actualizados=${paymentsUpdated} saltados=${rowsSkipped} | invoices afectadas=${affectedInvoiceIds.size}`
  );

  // 4. Recalcular cada invoice afectada y reflejar derivados en Sheets
  let sheetsUpdated = 0;
  let sheetsFailed = 0;

  for (const invoiceId of affectedInvoiceIds) {
    const result = await recalculateInvoicePayment(prisma, invoiceId);
    if (!result) continue;

    try {
      const ok = await sheetsService.updateInvoicePaymentInfo(
        sheetName,
        mapping,
        {
          boletaNumber: result.boletaNumber,
          sourceFileUrl: result.sourceFileUrl,
          providerTaxId: result.providerTaxId,
        },
        {
          paymentStatus: result.isPaid
            ? "Pagado"
            : result.remainingBalance > 0
              ? "Pago parcial"
              : "Sin pagar",
          remainingBalance: result.isPaid ? 0 : result.remainingBalance,
          ...(result.newPeriodLabel ? { period: result.newPeriodLabel } : {}),
        }
      );
      if (ok) sheetsUpdated++;
      else sheetsFailed++;
    } catch (err) {
      sheetsFailed++;
      console.warn(
        `[sync-payments] Sheets update falló para invoice ${result.invoiceId}: ${
          err instanceof Error ? err.message : "error desconocido"
        }`
      );
    }
  }

  // 5. Persistir fecha de último sync
  const syncedAt = new Date();
  await prisma.schedulerState.upsert({
    where: { clientId },
    update: { lastPaymentsSyncAt: syncedAt },
    create: { clientId, lastPaymentsSyncAt: syncedAt },
  });

  console.log(
    `[sync-payments] ✅ Completado en ${Date.now() - startTime}ms — creados=${paymentsCreated} actualizados=${paymentsUpdated} sheets ok=${sheetsUpdated} fallos=${sheetsFailed}`
  );

  return {
    paymentsCreated,
    paymentsUpdated,
    rowsSkipped,
    invoicesAffected: affectedInvoiceIds.size,
    sheetsUpdated,
    sheetsFailed,
    warnings,
    syncedAt,
  };
}
