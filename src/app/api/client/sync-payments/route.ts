import { NextRequest, NextResponse } from "next/server";
import { requireClientSession } from "@/lib/clientAuth";
import { syncInvoicePaymentsFromSheets, SyncPaymentsError } from "@/lib/syncInvoicePayments";

/**
 * POST /api/client/sync-payments
 *
 * Lee las columnas Q (MONTO PAGADO), R (CANT CUOTAS), S (FECHA PAGO),
 * T (URL COMPROBANTE) y U (MEDIO PAGO) de cada fila de la hoja de boletas y
 * reconcilia con la tabla Payment de la DB.
 *
 * Toda la lógica vive en `syncInvoicePaymentsFromSheets` (reusada por
 * `/api/client/setup-sheet-protection` para auto-sync antes de re-proteger).
 */
export async function POST(request: NextRequest) {
  const auth = requireClientSession(request);
  if (auth.error) return auth.error;

  const clientId = auth.session.clientId;

  try {
    const result = await syncInvoicePaymentsFromSheets(clientId);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof SyncPaymentsError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: err.statusCode });
    }
    const message = err instanceof Error ? err.message : "Error al sincronizar pagos";
    console.error(`[sync-payments] ❌ ${message}`);
    if (message.includes("403") || message.includes("PERMISSION_DENIED")) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Sin permisos sobre el archivo de boletas. Compartilo con la cuenta de servicio de Google.",
        },
        { status: 403 }
      );
    }
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
