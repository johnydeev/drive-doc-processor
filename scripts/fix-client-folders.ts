/**
 * scripts/fix-client-folders.ts
 * Diagnostica y repara driveFoldersJson de clientes con problemas.
 *
 * Uso — solo diagnóstico:
 *   npx tsx scripts/fix-client-folders.ts
 *
 * Uso — aplicar fix a un cliente específico:
 *   npx tsx scripts/fix-client-folders.ts --clientId=<ID> --pending=<FOLDER_ID> --scanned=<FOLDER_ID>
 *
 * Opcionales:
 *   --unassigned=<FOLDER_ID>
 *   --failed=<FOLDER_ID>     también destino al eliminar boletas desde la UI ("Revisión")
 *   --receipts=<FOLDER_ID>
 */

import "@/lib/loadEnv";
import { getPrismaClient } from "@/lib/prisma";

async function main() {
  const prisma = getPrismaClient();
  const args = Object.fromEntries(
    process.argv.slice(2)
      .filter((a) => a.startsWith("--"))
      .map((a) => {
        const [k, v] = a.slice(2).split("=");
        return [k, v ?? "true"];
      })
  );

  // ── MODO DIAGNÓSTICO ──────────────────────────────────────────────────────
  if (!args.clientId) {
    console.log("\n=== DIAGNÓSTICO DE CLIENTES ===\n");

    const clients = await prisma.client.findMany({
      select: { id: true, name: true, email: true, isActive: true, driveFoldersJson: true },
      orderBy: { createdAt: "asc" },
    });

    for (const c of clients) {
      const folders = c.driveFoldersJson as Record<string, string> | null;
      const pending  = folders?.pending?.trim()  || "";
      const scanned  = folders?.scanned?.trim()  || "";

      const issues: string[] = [];
      if (!folders)              issues.push("❌ driveFoldersJson es NULL");
      if (!pending)              issues.push("❌ pending vacío o faltante");
      else if (pending === ".")  issues.push("❌ pending es '.' (inválido)");
      if (!scanned)              issues.push("❌ scanned vacío o faltante");
      else if (scanned === ".")  issues.push("❌ scanned es '.' (inválido)");
      if (pending && scanned && pending === scanned) issues.push("⚠️  pending === scanned (deben ser distintos)");

      const status = issues.length === 0 ? "✓ OK" : issues.join(" | ");
      console.log(`[${c.id}] ${c.name || "(sin nombre)"} <${c.email}>`);
      console.log(`  driveFoldersJson: ${JSON.stringify(folders)}`);
      console.log(`  ${status}`);
      console.log();
    }

    console.log("Para corregir un cliente:");
    console.log("  npx tsx scripts/fix-client-folders.ts --clientId=<ID> --pending=<DRIVE_ID> --scanned=<DRIVE_ID>\n");
    return;
  }

  // ── MODO FIX ─────────────────────────────────────────────────────────────
  const { clientId, pending, scanned, unassigned, failed, receipts } = args;

  if (!pending || !scanned) {
    console.error("❌ --pending y --scanned son obligatorios para aplicar el fix");
    process.exit(1);
  }

  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { id: true, name: true, driveFoldersJson: true } });
  if (!client) {
    console.error(`❌ Cliente no encontrado: ${clientId}`);
    process.exit(1);
  }

  const existing = (client.driveFoldersJson as Record<string, string> | null) ?? {};

  const newFolders: Record<string, string> = {
    ...existing,
    pending:  pending.trim(),
    scanned:  scanned.trim(),
  };
  if (unassigned?.trim()) newFolders.unassigned = unassigned.trim();
  if (failed?.trim())     newFolders.failed     = failed.trim();
  if (receipts?.trim())   newFolders.receipts   = receipts.trim();

  await prisma.client.update({
    where: { id: clientId },
    data: { driveFoldersJson: newFolders },
  });

  console.log(`\n✓ Cliente actualizado: ${client.name || "(sin nombre)"} [${clientId}]`);
  console.log(`  driveFoldersJson: ${JSON.stringify(newFolders)}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
