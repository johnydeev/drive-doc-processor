import { NextRequest, NextResponse } from "next/server";
import { requireClientSession } from "@/lib/clientAuth";
import { getPrismaClient } from "@/lib/prisma";
import { isZip } from "@/lib/fileSignature";

/**
 * POST /api/client/import
 *
 * Importa edificios y proveedores desde un archivo Excel.
 * Hojas esperadas:
 *   - "Edificios":   Nombre | CUIT | Aliases | Alias de pago
 *   - "Proveedores": Nombre | CUIT | Alias | Alias de pago
 *
 * Comportamiento con duplicados: skip (no sobreescribe existentes).
 */
export async function POST(request: NextRequest) {
  const auth = requireClientSession(request);
  if (auth.error) return auth.error;

  const clientId = auth.session.clientId;

  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    if (!file) {
      return NextResponse.json({ ok: false, error: "No se envió ningún archivo" }, { status: 400 });
    }

    const ext = file.name.split(".").pop()?.toLowerCase();
    if (!["xlsx", "xls"].includes(ext ?? "")) {
      return NextResponse.json({ ok: false, error: "Solo se aceptan archivos .xlsx o .xls" }, { status: 400 });
    }

    const MAX_EXCEL_SIZE = 10 * 1024 * 1024; // 10MB
    if (file.size > MAX_EXCEL_SIZE) {
      return NextResponse.json(
        { ok: false, error: "El archivo Excel no puede superar 10MB" },
        { status: 400 }
      );
    }

    const VALID_EXCEL_MIMES = [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel",
    ];
    if (!VALID_EXCEL_MIMES.includes(file.type)) {
      return NextResponse.json(
        { ok: false, error: "El archivo debe ser un Excel (.xlsx o .xls)" },
        { status: 400 }
      );
    }

    // Importar xlsx dinámicamente para no romper el edge runtime en otros endpoints
    const XLSX = await import("xlsx");
    const buffer = Buffer.from(await file.arrayBuffer());

    // Magic bytes: xlsx es un ZIP/OOXML (PK\x03\x04). Para .xls (formato CFB binario clásico)
    // no validamos firma — confiamos en MIME + extensión + parseo de XLSX.read.
    if (ext === "xlsx" && !isZip(buffer)) {
      return NextResponse.json(
        { ok: false, error: "El archivo no es un .xlsx válido (firma binaria incorrecta)" },
        { status: 400 }
      );
    }

    const workbook = XLSX.read(buffer, { type: "buffer" });

    // ── Parsear hoja Edificios ────────────────────────────────────────────
    const edificiosSheet = workbook.Sheets["Edificios"] ?? workbook.Sheets["edificios"];
    const proveedoresSheet = workbook.Sheets["Proveedores"] ?? workbook.Sheets["proveedores"];

    if (!edificiosSheet && !proveedoresSheet) {
      return NextResponse.json({
        ok: false,
        error: "El archivo no contiene hojas 'Edificios' ni 'Proveedores'.",
      }, { status: 400 });
    }

    const prisma = getPrismaClient();
    const { ConsortiumRepository } = await import("@/repositories/consortium.repository");
    const repo = new ConsortiumRepository();
    const { year, month } = await repo.resolveMajorityMonth(clientId);

    const result = {
      edificios:   { imported: 0, skipped: 0, errors: [] as string[] },
      proveedores: { imported: 0, skipped: 0, errors: [] as string[] },
    };

    // ── Importar Edificios ────────────────────────────────────────────────
    if (edificiosSheet) {
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(edificiosSheet, {
        defval: "",
        raw: false,
      });

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const rowNum = i + 2; // +2 porque fila 1 = encabezados

        // Buscar columna Nombre (insensible a mayúsculas/tildes)
        const nombre = pickCell(row, ["Nombre", "nombre", "NOMBRE", "canonicalName", "Canonical Name"])?.trim();
        if (!nombre) {
          result.edificios.errors.push(`Fila ${rowNum}: columna "Nombre" vacía — omitida`);
          continue;
        }

        const cuit         = pickCell(row, ["CUIT", "cuit", "Cuit"])?.trim() || null;
        const matchNames   = pickCell(row, ["Aliases", "aliases", "Alias", "alias", "Nombres alternativos"])?.trim() || null;
        const paymentAlias = pickCell(row, ["Alias de pago", "alias de pago", "PaymentAlias", "paymentAlias"])?.trim() || null;

        // Verificar si ya existe
        const existing = await prisma.consortium.findUnique({
          where: { clientId_canonicalName: { clientId, canonicalName: nombre } },
          select: { id: true },
        });

        if (existing) {
          result.edificios.skipped++;
          continue;
        }

        // Crear consorcio + período activo
        await prisma.$transaction(async (tx) => {
          const consortium = await tx.consortium.create({
            data: {
              clientId,
              canonicalName: nombre,
              rawName:       nombre,
              cuit:          cuit || null,
              matchNames:    matchNames || null,
              paymentAlias:  paymentAlias || null,
              cutoffDay:     5,
            },
          });

          await tx.period.create({
            data: {
              clientId,
              consortiumId: consortium.id,
              year,
              month,
              status: "ACTIVE",
            },
          });
        });

        result.edificios.imported++;
      }
    }

    // ── Importar Proveedores ──────────────────────────────────────────────
    if (proveedoresSheet) {
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(proveedoresSheet, {
        defval: "",
        raw: false,
      });

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const rowNum = i + 2;

        const nombre = pickCell(row, ["Nombre", "nombre", "NOMBRE", "canonicalName", "Razón Social", "Razon Social"])?.trim();
        if (!nombre) {
          result.proveedores.errors.push(`Fila ${rowNum}: columna "Nombre" vacía — omitida`);
          continue;
        }

        const cuit         = pickCell(row, ["CUIT", "cuit", "Cuit"])?.trim() || null;
        const matchNames   = pickCell(row, ["Alias", "alias", "ALIAS", "Nombres alternativos"])?.trim() || null;
        const paymentAlias = pickCell(row, ["Alias de pago", "alias de pago", "PaymentAlias", "paymentAlias"])?.trim() || null;

        // Verificar si ya existe por nombre
        const existingByName = await prisma.provider.findFirst({
          where: { clientId, canonicalName: nombre },
          select: { id: true },
        });

        // Verificar si ya existe por CUIT (si viene CUIT)
        const normCuit = cuit?.replace(/\D/g, "") ?? "";
        const existingByCuit = normCuit.length >= 10
          ? await prisma.provider.findFirst({
              where: { clientId, cuit: { contains: normCuit } },
              select: { id: true },
            })
          : null;

        if (existingByName || existingByCuit) {
          result.proveedores.skipped++;
          continue;
        }

        await prisma.provider.create({
          data: {
            clientId,
            canonicalName: nombre,
            cuit:          cuit || null,
            matchNames:    matchNames || null,
            paymentAlias:  paymentAlias || null,
          },
        });

        result.proveedores.imported++;
      }
    }

    return NextResponse.json({ ok: true, result });
  } catch (err) {
    console.error("[import]", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Error interno al procesar el archivo" },
      { status: 500 }
    );
  }
}

/** Busca el valor de la primera clave que exista en el objeto, insensible al orden */
function pickCell(row: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    if (key in row && row[key] !== undefined && row[key] !== null) {
      return String(row[key]);
    }
  }
  return undefined;
}
