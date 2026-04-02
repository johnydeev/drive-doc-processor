import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedSession } from "@/lib/adminAuth";
import { getPrismaClient } from "@/lib/prisma";
import { GoogleSheetsService } from "@/services/googleSheets.service";
import { resolveGoogleConfig } from "@/lib/clientProcessingConfig";

export async function POST(request: NextRequest) {
  const auth = requireAuthenticatedSession(request);
  if (auth.error) return auth.error;

  const clientId = auth.session.clientId;

  try {
    const startTime = Date.now();
    console.log(`[sync-directory] Iniciando sincronización — clientId=${clientId}`);

    const prisma = getPrismaClient();

    const client = await prisma.client.findUnique({ where: { id: clientId } });
    if (!client) {
      return NextResponse.json({ ok: false, error: "Cliente no encontrado" }, { status: 404 });
    }

    const rawConfig = client.googleConfigJson as Record<string, unknown> | null;
    const altaSheetsId = rawConfig?.altaSheetsId as string | undefined;

    if (!altaSheetsId) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Configurá el ID del archivo ALTA de Google Sheets antes de sincronizar. " +
            "Creá un archivo llamado 'ALTA' compartido con la cuenta de servicio y pegá su ID en la configuración.",
        },
        { status: 400 }
      );
    }

    // resolveGoogleConfig desencripta la private key correctamente
    const googleConfig = resolveGoogleConfig(client as any);
    if (!googleConfig) {
      return NextResponse.json(
        { ok: false, error: "Credenciales de Google incompletas" },
        { status: 400 }
      );
    }

    // Usar las mismas credenciales pero apuntando al archivo ALTA
    const altaService = new GoogleSheetsService({ ...googleConfig, sheetsId: altaSheetsId });

    const directory = await altaService.readDirectory();
    console.log(`[sync-directory] Directorio leído — consorcios=${directory.consortiums.length} proveedores=${directory.providers.length} rubros=${directory.rubros.length} coeficientes=${directory.coeficientes.length} lspServices=${directory.lspServices.length}`);

    const warnings: string[] = [...directory.warnings];

    const syncedAt = new Date();

    const txOpts = { maxWait: 10000, timeout: 30000 };

    // Transacción 1: Rubros (reemplazo total)
    await prisma.$transaction(async (tx) => {
      await tx.rubro.deleteMany({ where: { clientId } });
      if (directory.rubros.length > 0) {
        await tx.rubro.createMany({
          data: directory.rubros.map((r) => ({
            clientId,
            name: r.name,
            description: r.description,
          })),
        });
      }
    }, txOpts);

    // Transacción 2: Coeficientes (reemplazo total)
    await prisma.$transaction(async (tx) => {
      await tx.coeficiente.deleteMany({ where: { clientId } });
      if (directory.coeficientes.length > 0) {
        await tx.coeficiente.createMany({
          data: directory.coeficientes.map((c) => ({
            clientId,
            code: c.code,
            name: c.name,
          })),
        });
      }
    }, txOpts);

    // Transacción 3: Consorcios + Períodos
    await prisma.$transaction(async (tx) => {
      for (const c of directory.consortiums) {
        await tx.consortium.upsert({
          where: { clientId_canonicalName: { clientId, canonicalName: c.canonicalName } },
          update: { cuit: c.cuit, matchNames: c.matchNames, paymentAlias: c.paymentAlias },
          create: {
            clientId,
            canonicalName: c.canonicalName,
            rawName: c.canonicalName,
            cuit: c.cuit,
            matchNames: c.matchNames,
            paymentAlias: c.paymentAlias,
          },
        });
      }

      // Crear período activo para consorcios nuevos que no tengan uno
      const allConsortiumsAfterUpsert = await tx.consortium.findMany({
        where: { clientId },
        select: { id: true, canonicalName: true },
      });
      const existingPeriods = await tx.period.findMany({
        where: { consortiumId: { in: allConsortiumsAfterUpsert.map((c) => c.id) }, status: "ACTIVE" },
        select: { consortiumId: true },
      });
      const consWithPeriod = new Set(existingPeriods.map((p) => p.consortiumId));
      const consWithoutPeriod = allConsortiumsAfterUpsert.filter((c) => !consWithPeriod.has(c.id));

      if (consWithoutPeriod.length > 0) {
        const activePeriods = await tx.period.findMany({
          where: { consortium: { clientId }, status: "ACTIVE" },
          select: { year: true, month: true },
        });

        let periodYear: number;
        let periodMonth: number;

        if (activePeriods.length === 0) {
          const now = new Date();
          periodYear = now.getFullYear();
          periodMonth = now.getMonth() + 1;
        } else {
          const freq = new Map<string, number>();
          for (const p of activePeriods) {
            const key = `${p.year}-${p.month}`;
            freq.set(key, (freq.get(key) ?? 0) + 1);
          }
          let majorityKey = "";
          let majorityCount = 0;
          for (const [key, count] of freq) {
            if (count > majorityCount) { majorityKey = key; majorityCount = count; }
          }
          const [y, m] = majorityKey.split("-").map(Number);
          periodYear = y;
          periodMonth = m;
        }

        await tx.period.createMany({
          data: consWithoutPeriod.map((c) => ({
            clientId,
            consortiumId: c.id,
            year: periodYear,
            month: periodMonth,
            status: "ACTIVE" as const,
          })),
        });
      }

      const sheetsConsortiumNames = new Set(directory.consortiums.map((c) => c.canonicalName));
      const dbConsortiums = await tx.consortium.findMany({
        where: { clientId },
        select: { id: true, canonicalName: true },
      });
      const orphanConsortiumIds = dbConsortiums
        .filter((c) => !sheetsConsortiumNames.has(c.canonicalName))
        .map((c) => c.id);

      if (orphanConsortiumIds.length > 0) {
        try {
          await tx.consortium.deleteMany({ where: { id: { in: orphanConsortiumIds } } });
        } catch {
          warnings.push(
            `${orphanConsortiumIds.length} consorcio(s) no pudieron eliminarse porque tienen boletas asociadas. Eliminalos manualmente desde el panel.`
          );
        }
      }
    }, txOpts);

    // Transacción 4: Proveedores
    await prisma.$transaction(async (tx) => {
      for (const p of directory.providers) {
        await tx.provider.upsert({
          where: { clientId_canonicalName: { clientId, canonicalName: p.canonicalName } },
          update: { cuit: p.cuit, matchNames: p.matchNames, paymentAlias: p.paymentAlias },
          create: { clientId, canonicalName: p.canonicalName, cuit: p.cuit, matchNames: p.matchNames, paymentAlias: p.paymentAlias },
        });
      }

      const sheetsProviderNames = new Set(directory.providers.map((p) => p.canonicalName));
      const dbProviders = await tx.provider.findMany({
        where: { clientId },
        select: { id: true, canonicalName: true },
      });
      const orphanProviderIds = dbProviders
        .filter((p) => !sheetsProviderNames.has(p.canonicalName))
        .map((p) => p.id);

      if (orphanProviderIds.length > 0) {
        try {
          await tx.provider.deleteMany({ where: { id: { in: orphanProviderIds } } });
        } catch {
          warnings.push(
            `${orphanProviderIds.length} proveedor(es) no pudieron eliminarse porque tienen boletas asociadas. Eliminalos manualmente desde el panel.`
          );
        }
      }
    }, txOpts);

    // Transacción 5: LspServices (reemplazo total)
    await prisma.$transaction(async (tx) => {
      if (directory.lspServices.length > 0) {
        await tx.lspService.deleteMany({ where: { clientId } });

        const currentConsortiums = await tx.consortium.findMany({
          where: { clientId },
          select: { id: true, canonicalName: true },
        });
        const consortiumMap = new Map(currentConsortiums.map((c) => [c.canonicalName, c.id]));

        const currentProviders = await tx.provider.findMany({
          where: { clientId },
          select: { id: true, canonicalName: true },
        });
        const providerMap = new Map(currentProviders.map((p) => [p.canonicalName.toUpperCase(), p.id]));

        const validLspServices: Array<{
          clientId: string;
          consortiumId: string;
          provider: string;
          providerId: string | null;
          clientNumber: string;
          description: string | null;
        }> = [];

        for (const ls of directory.lspServices) {
          const consortiumId = consortiumMap.get(ls.consortiumName);
          if (!consortiumId) {
            warnings.push(
              `LspService ignorado: consorcio "${ls.consortiumName}" no encontrado para proveedor ${ls.provider} nro ${ls.clientNumber}`
            );
            continue;
          }
          const providerId = providerMap.get(ls.provider.toUpperCase()) ?? null;
          validLspServices.push({
            clientId,
            consortiumId,
            provider: ls.provider,
            providerId,
            clientNumber: ls.clientNumber.replace(/^0+/, "") || ls.clientNumber,
            description: ls.description,
          });
        }

        if (validLspServices.length > 0) {
          await tx.lspService.createMany({ data: validLspServices });
        }
      } else {
        await tx.lspService.deleteMany({ where: { clientId } });
      }
    }, txOpts);

    // Guardar fecha de última sincronización
    await prisma.schedulerState.upsert({
      where: { clientId },
      update: { lastDirectorySyncAt: syncedAt },
      create: { clientId, lastDirectorySyncAt: syncedAt },
    });

    return NextResponse.json({
      ok: true,
      consortiumsCount: directory.consortiums.length,
      providersCount: directory.providers.length,
      rubrosCount: directory.rubros.length,
      coeficientesCount: directory.coeficientes.length,
      lspServicesCount: directory.lspServices.length,
      syncedAt,
      ...(warnings.length > 0 && { warnings }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error al sincronizar";

    if (message.includes("403") || message.includes("PERMISSION_DENIED")) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Sin permisos de lectura en el archivo ALTA. Compartilo con la cuenta de servicio de Google.",
        },
        { status: 403 }
      );
    }

    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
