import { NextRequest, NextResponse } from "next/server";
import { requireClientSession } from "@/lib/clientAuth";
import { getPrismaClient } from "@/lib/prisma";
import { GoogleDriveService } from "@/services/googleDrive.service";
import { GoogleSheetsService, SheetsRowMapping } from "@/services/googleSheets.service";
import { resolveGoogleConfig, resolveMapping, resolveSheetName, resolveFolders } from "@/lib/clientProcessingConfig";
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
 * DELETE /api/client/consortiums/[id]/invoices/[invoiceId]
 *
 * Elimina una boleta completa. Validaciones y efectos:
 *   1. La boleta pertenece al cliente y al consorcio.
 *   2. NO tiene pagos asociados (409 si tiene — el usuario debe borrarlos primero).
 *   3. Mueve el PDF en Drive de "scanned" → "pending" (fallback si no estaba en
 *      scanned, intenta unassigned → pending). El archivo no se borra, se
 *      reintegra a la cola.
 *   4. Si la boleta tiene `receiptDriveFileId` (recibo manual subido en algún
 *      momento), lo manda a la papelera de Drive.
 *   5. Borra la fila completa en Google Sheets (no la blanquea — `deleteDimension`).
 *   6. Borra el Invoice de la DB.
 *
 * Operación atómica: si Drive o Sheets fallan, se aborta antes de tocar la DB.
 */
export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string; invoiceId: string }> }
) {
  const auth = requireClientSession(request);
  if (auth.error) return auth.error;

  const { id: consortiumId, invoiceId } = await context.params;
  const clientId = auth.session.clientId;

  try {
    const prisma = getPrismaClient();

    // ── 1. Cargar invoice + verificar pertenencia ─────────────────────────
    const invoice = await prisma.invoice.findFirst({
      where: { id: invoiceId, clientId, consortiumId },
      include: {
        _count: { select: { payments: true } },
        receipt: { select: { id: true, driveFileId: true } },
      },
    });
    if (!invoice) {
      return NextResponse.json({ ok: false, error: "Boleta no encontrada" }, { status: 404 });
    }

    // ── 2. Bloquear si tiene pagos ────────────────────────────────────────
    if (invoice._count.payments > 0) {
      return NextResponse.json(
        {
          ok: false,
          error: `No se puede eliminar: la boleta tiene ${invoice._count.payments} pago(s) registrado(s). Eliminá los pagos primero.`,
        },
        { status: 409 }
      );
    }

    // ── 3. Resolver config Google del cliente ─────────────────────────────
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
    if (!googleConfig) {
      return NextResponse.json(
        { ok: false, error: "Sin credenciales de Google configuradas" },
        { status: 400 }
      );
    }

    const folders = resolveFolders(processingClient);
    const driveService = new GoogleDriveService(googleConfig);

    // ── 4. Mover PDF de Drive scanned → pending (o unassigned → pending) ──
    // Operación atómica: si esto falla, abortamos antes de tocar DB.
    if (invoice.driveFileId && folders.pending) {
      try {
        const parents = await driveService.getFileParents(invoice.driveFileId);
        const fromFolderId =
          parents.find((p) => p === folders.scanned) ??
          parents.find((p) => p === folders.unassigned) ??
          parents[0];

        if (fromFolderId && fromFolderId !== folders.pending) {
          await driveService.moveFileToFolder(invoice.driveFileId, fromFolderId, folders.pending);
        }
      } catch (err) {
        return NextResponse.json(
          {
            ok: false,
            error: `Drive falló al mover el archivo: ${err instanceof Error ? err.message : "Error"}`,
          },
          { status: 502 }
        );
      }
    }

    // ── 5. Borrar receipt manual del Drive (si existe) ────────────────────
    // El Receipt es un modelo separado relacionado 1:1 con Invoice. Si la
    // boleta tenía un recibo manual, mandamos el archivo a la papelera y
    // borramos también el registro de Receipt en DB (paso 7).
    if (invoice.receipt?.driveFileId) {
      try {
        await driveService.trashFile(invoice.receipt.driveFileId);
      } catch (err) {
        return NextResponse.json(
          {
            ok: false,
            error: `Drive falló al borrar el recibo: ${err instanceof Error ? err.message : "Error"}`,
          },
          { status: 502 }
        );
      }
    }

    // ── 6. Borrar fila en Sheets ──────────────────────────────────────────
    const sheetName = resolveSheetName(processingClient);
    const mapping = resolveMapping(processingClient) ?? DEFAULT_MAPPING;
    const sheetsService = new GoogleSheetsService(googleConfig);

    try {
      await sheetsService.deleteInvoiceRow(sheetName, mapping, {
        boletaNumber: invoice.boletaNumber,
        sourceFileUrl: invoice.sourceFileUrl,
        providerTaxId: invoice.providerTaxId,
      });
    } catch (err) {
      return NextResponse.json(
        {
          ok: false,
          error: `Sheets falló al borrar la fila: ${err instanceof Error ? err.message : "Error"}`,
        },
        { status: 502 }
      );
    }

    // ── 7. Borrar Invoice + Receipt asociado de DB (transacción) ──────────
    await prisma.$transaction(async (tx) => {
      if (invoice.receipt) {
        await tx.receipt.delete({ where: { id: invoice.receipt.id } });
      }
      await tx.invoice.delete({ where: { id: invoiceId } });
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[invoice-delete]", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Error interno" },
      { status: 500 }
    );
  }
}
