import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuthenticatedSession } from "@/lib/adminAuth";
import { getPrismaClient } from "@/lib/prisma";
import { createHash } from "crypto";
import { GoogleSheetsService, SheetsRowMapping } from "@/services/googleSheets.service";
import { resolveGoogleConfig, resolveMapping, resolveSheetName } from "@/lib/clientProcessingConfig";
import { ClientDriveFolders, ClientGoogleConfig, ProcessingClient } from "@/types/client.types";
import { ExtractedDocumentData } from "@/types/extractedDocument.types";

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
};

const TIPO_GASTO_VALUES = ["ORDINARIO", "EXTRAORDINARIO", "PARTICULAR"] as const;

const createSchema = z.object({
  providerId:       z.string().min(1),
  periodId:         z.string().min(1),
  boletaNumber:     z.string().optional(),
  providerTaxId:    z.string().optional(),
  detail:           z.string().optional(),
  observation:      z.string().optional(),
  issueDate:        z.string().optional(),
  dueDate:          z.string().optional(),
  amount:           z.number().optional(),
  coeficienteId:    z.string().optional(),
  rubroId:          z.string().optional(),
  tipoGasto:        z.enum(TIPO_GASTO_VALUES).default("ORDINARIO"),
  tipoComprobante:  z.string().optional(),
});

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const auth = requireAuthenticatedSession(request);
  if (auth.error) return auth.error;

  const { id: consortiumId } = await context.params;
  const { searchParams } = new URL(request.url);
  const periodId = searchParams.get("periodId");

  try {
    const prisma = getPrismaClient();

    const consortium = await prisma.consortium.findFirst({
      where: { id: consortiumId, clientId: auth.session.clientId },
      select: { id: true },
    });
    if (!consortium) {
      return NextResponse.json({ ok: false, error: "Consorcio no encontrado" }, { status: 404 });
    }

    const invoices = await prisma.invoice.findMany({
      where: {
        consortiumId,
        clientId: auth.session.clientId,
        ...(periodId ? { periodId } : {}),
      },
      include: {
        coeficienteRef: { select: { id: true, name: true, value: true } },
        rubroRef:       { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json({ ok: true, invoices });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Error al obtener boletas" },
      { status: 500 }
    );
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const auth = requireAuthenticatedSession(request);
  if (auth.error) return auth.error;

  const { id: consortiumId } = await context.params;

  try {
    const prisma = getPrismaClient();

    const consortium = await prisma.consortium.findFirst({
      where: { id: consortiumId, clientId: auth.session.clientId },
      select: { id: true, rawName: true },
    });
    if (!consortium) {
      return NextResponse.json({ ok: false, error: "Consorcio no encontrado" }, { status: 404 });
    }

    const body = createSchema.parse(await request.json());

    const period = await prisma.period.findFirst({
      where: { id: body.periodId, consortiumId },
      select: { id: true, month: true, year: true },
    });
    if (!period) {
      return NextResponse.json({ ok: false, error: "Período no encontrado" }, { status: 404 });
    }

    const provider = await prisma.provider.findFirst({
      where: { id: body.providerId, clientId: auth.session.clientId },
      select: { id: true, canonicalName: true, cuit: true },
    });
    if (!provider) {
      return NextResponse.json({ ok: false, error: "Proveedor no encontrado" }, { status: 404 });
    }

    const hashInput = `manual:${auth.session.clientId}:${consortiumId}:${body.boletaNumber ?? ""}:${body.amount ?? ""}:${Date.now()}`;
    const documentHash = createHash("sha256").update(hashInput).digest("hex");

    const canonicalTaxId = provider.cuit || body.providerTaxId || null;
    const canonicalTaxIdNorm = (canonicalTaxId ?? "").replace(/\D/g, "");

    const invoice = await prisma.invoice.create({
      data: {
        clientId:         auth.session.clientId,
        consortiumId,
        providerId:       body.providerId,
        periodId:         body.periodId,
        documentHash,
        boletaNumber:     body.boletaNumber || null,
        provider:         provider.canonicalName,
        providerTaxId:    canonicalTaxId,
        detail:           body.detail || null,
        observation:      body.observation || null,
        issueDate:        body.issueDate ? new Date(body.issueDate) : null,
        dueDate:          body.dueDate ? new Date(body.dueDate) : null,
        amount:           body.amount ?? null,
        coeficienteId:    body.coeficienteId || null,
        rubroId:          body.rubroId || null,
        tipoGasto:        body.tipoGasto,
        tipoComprobante:  body.tipoComprobante || null,
        isManual:         true,
        isDuplicate:      false,
        boletaNumberNorm: (body.boletaNumber ?? "").toUpperCase().trim(),
        providerTaxIdNorm: canonicalTaxIdNorm,
        dueDateNorm:      body.dueDate ?? "",
        amountNorm:       body.amount != null ? String(Number(body.amount).toFixed(2)) : "",
      },
    });

    // Insertar en Google Sheets
    try {
      const clientRow = await prisma.client.findUnique({
        where: { id: auth.session.clientId },
        select: { driveFoldersJson: true, googleConfigJson: true, extractionConfigJson: true },
      });

      if (clientRow) {
        const processingClient: ProcessingClient = {
          id: auth.session.clientId,
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
          const sheetData: ExtractedDocumentData = {
            boletaNumber:  invoice.boletaNumber,
            provider:      invoice.provider,
            consortium:    consortium.rawName,
            providerTaxId: invoice.providerTaxId,
            detail:        invoice.detail,
            observation:   invoice.observation,
            dueDate:       invoice.dueDate ? invoice.dueDate.toISOString().slice(0, 10) : null,
            amount:        invoice.amount ? Number(invoice.amount) : null,
            alias:         null,
            clientNumber:  null,
            paymentMethod: null,
            period:        period ? `${String(period.month).padStart(2, "0")}/${period.year}` : null,
            sourceFileUrl: null,
            isDuplicate:   "NO",
            paymentStatus: "Sin pagar",
          };
          await sheetsService.insertRow(sheetName, sheetData, mapping);
        }
      }
    } catch (sheetsError) {
      console.warn(
        `[manual-invoice] sheets insert failed invoiceId=${invoice.id}: ${
          sheetsError instanceof Error ? sheetsError.message : "Unknown error"
        }`
      );
    }

    return NextResponse.json({ ok: true, invoice });
  } catch (error) {
    const message =
      error instanceof z.ZodError
        ? error.issues.map((i) => i.message).join(", ")
        : error instanceof Error
          ? error.message
          : "Unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
