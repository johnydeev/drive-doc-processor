/**
 * Migra secretos cifrados con el formato legado (`enc:...`) al formato v2 (`enc:v2:...`).
 *
 * Uso:
 *   tsx scripts/rotate-encrypted-secrets.ts            # dry-run (solo reporta)
 *   tsx scripts/rotate-encrypted-secrets.ts --apply    # aplica cambios en DB
 *
 * Requisitos:
 *   - GOOGLE_CREDENTIALS_ENCRYPTION_KEY configurada (clave dedicada para v2).
 *   - Si los secretos legados se cifraron con SESSION_SECRET, mantenelo configurado
 *     hasta correr el script (la lectura legada usa el fallback automáticamente).
 *
 * El script es idempotente: si ya está todo en v2, no toca nada.
 *
 * Campos rotados:
 *   - googleConfigJson.privateKey
 *   - extractionConfigJson.geminiApiKey
 *   - extractionConfigJson.openaiApiKey
 */

import { getPrismaClient } from "@/lib/prisma";
import { decrypt, encrypt, isLegacyEncrypted } from "@/utils/encryption.util";

const APPLY = process.argv.includes("--apply");

type RotationResult = {
  clientId: string;
  email: string;
  rotated: string[];
  skipped: string[];
  errors: string[];
};

function rotateField(value: unknown): { changed: boolean; next: string | null; error?: string } {
  if (typeof value !== "string" || value.length === 0) {
    return { changed: false, next: null };
  }
  if (!isLegacyEncrypted(value)) {
    return { changed: false, next: value };
  }
  try {
    const plaintext = decrypt(value);
    const reEncrypted = encrypt(plaintext);
    return { changed: true, next: reEncrypted };
  } catch (err) {
    return {
      changed: false,
      next: value,
      error: err instanceof Error ? err.message : "decrypt failed",
    };
  }
}

async function main() {
  if (!process.env.GOOGLE_CREDENTIALS_ENCRYPTION_KEY) {
    console.error(
      "❌ GOOGLE_CREDENTIALS_ENCRYPTION_KEY no está configurada. " +
      "Generá una con `openssl rand -hex 32` y agregala al .env antes de correr este script."
    );
    process.exit(1);
  }

  const prisma = getPrismaClient();
  const clients = await prisma.client.findMany({
    select: {
      id: true,
      email: true,
      googleConfigJson: true,
      extractionConfigJson: true,
    },
  });

  console.log(`\n[rotate] Modo: ${APPLY ? "APPLY (escribe en DB)" : "DRY-RUN (no modifica)"}`);
  console.log(`[rotate] Clientes encontrados: ${clients.length}\n`);

  const results: RotationResult[] = [];
  let totalRotated = 0;

  for (const client of clients) {
    const result: RotationResult = {
      clientId: client.id,
      email: client.email,
      rotated: [],
      skipped: [],
      errors: [],
    };

    const google = (client.googleConfigJson ?? {}) as Record<string, unknown>;
    const extraction = (client.extractionConfigJson ?? {}) as Record<string, unknown>;

    const updates: { google?: typeof google; extraction?: typeof extraction } = {};

    // googleConfigJson.privateKey
    const pk = rotateField(google.privateKey);
    if (pk.error) result.errors.push(`googleConfigJson.privateKey: ${pk.error}`);
    if (pk.changed) {
      updates.google = { ...google, privateKey: pk.next };
      result.rotated.push("googleConfigJson.privateKey");
    } else if (typeof google.privateKey === "string" && google.privateKey.startsWith("enc:v2:")) {
      result.skipped.push("googleConfigJson.privateKey (ya v2)");
    }

    // extractionConfigJson.geminiApiKey
    const gk = rotateField(extraction.geminiApiKey);
    if (gk.error) result.errors.push(`extractionConfigJson.geminiApiKey: ${gk.error}`);
    if (gk.changed) {
      updates.extraction = { ...(updates.extraction ?? extraction), geminiApiKey: gk.next };
      result.rotated.push("extractionConfigJson.geminiApiKey");
    } else if (typeof extraction.geminiApiKey === "string" && extraction.geminiApiKey.startsWith("enc:v2:")) {
      result.skipped.push("extractionConfigJson.geminiApiKey (ya v2)");
    }

    // extractionConfigJson.openaiApiKey
    const ok = rotateField(extraction.openaiApiKey);
    if (ok.error) result.errors.push(`extractionConfigJson.openaiApiKey: ${ok.error}`);
    if (ok.changed) {
      updates.extraction = { ...(updates.extraction ?? extraction), openaiApiKey: ok.next };
      result.rotated.push("extractionConfigJson.openaiApiKey");
    } else if (typeof extraction.openaiApiKey === "string" && extraction.openaiApiKey.startsWith("enc:v2:")) {
      result.skipped.push("extractionConfigJson.openaiApiKey (ya v2)");
    }

    const hasChanges = Boolean(updates.google || updates.extraction);

    if (hasChanges) {
      totalRotated += result.rotated.length;
      if (APPLY) {
        await prisma.client.update({
          where: { id: client.id },
          data: {
            ...(updates.google && { googleConfigJson: updates.google as never }),
            ...(updates.extraction && { extractionConfigJson: updates.extraction as never }),
          },
        });
      }
    }

    if (result.rotated.length > 0 || result.errors.length > 0) {
      results.push(result);
    }
  }

  console.log("[rotate] Resumen:");
  for (const r of results) {
    console.log(`  • ${r.email} [${r.clientId}]`);
    for (const f of r.rotated) console.log(`      ${APPLY ? "✓" : "→"} ${f}`);
    for (const e of r.errors)  console.log(`      ✗ ERROR ${e}`);
  }
  if (results.length === 0) {
    console.log("  (nada para rotar — todo ya está en v2 o no hay secretos cifrados)");
  }

  console.log(`\n[rotate] Total campos rotados: ${totalRotated} ${APPLY ? "(escritos)" : "(dry-run, sin escribir)"}`);
  if (!APPLY && totalRotated > 0) {
    console.log("[rotate] Para aplicar los cambios, volvé a correr con --apply");
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("[rotate] Error fatal:", err);
  process.exit(1);
});
