import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { env } from "@/config/env";
import { requireAdminSession } from "@/lib/adminAuth";
import { hashPassword } from "@/lib/password";
import { getPrismaClient } from "@/lib/prisma";
import { parseProcessIntervalMinutes } from "@/jobs/runProcessingCycle";
import { encrypt } from "@/utils/encryption.util";

const bodySchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(8),
    companyName: z.string().min(2),
    driveFolderPending: z.string().min(5),
    driveFolderScanned: z.string().min(5),
    driveFolderUnassigned: z.string().optional(),
    driveFolderFailed: z.string().optional(),
    driveFolderReceipts: z.string().optional(),
    sheetsId: z.string().min(10),
    altaSheetsId: z.string().min(10).optional(),
    sheetName: z.string().min(1).optional(),
    geminiApiKey: z
      .string().trim().optional()
      .refine((v) => !v || v.length >= 10, "geminiApiKey debe tener al menos 10 caracteres"),
    openaiApiKey: z
      .string().trim().optional()
      .refine((v) => !v || v.length >= 10, "openaiApiKey debe tener al menos 10 caracteres"),
    anthropicApiKey: z
      .string().trim().optional()
      .refine((v) => !v || v.length >= 10, "anthropicApiKey debe tener al menos 10 caracteres"),
    googleProjectId: z.string().min(2).optional(),
    googleClientEmail: z.string().email().optional(),
    googlePrivateKey: z.string().min(50).optional(),
    googleServiceAccountJson: z
      .object({
        project_id: z.string().min(2),
        client_email: z.string().email(),
        private_key: z.string().min(50),
      })
      .optional(),
  })
  .refine(
    (input) =>
      Boolean(
        input.googleServiceAccountJson ||
          (input.googleProjectId && input.googleClientEmail && input.googlePrivateKey)
      ),
    {
      message:
        "Proporcioná googleServiceAccountJson o los campos googleProjectId/googleClientEmail/googlePrivateKey",
    }
  );

export async function POST(request: Request) {
  const auth = requireAdminSession(request);
  if (auth.error) return auth.error;

  try {
    const body = bodySchema.parse(await request.json());
    const prisma = getPrismaClient();

    const existing = await prisma.client.findUnique({
      where: { email: body.email.toLowerCase() },
      select: { id: true },
    });
    if (existing) {
      return NextResponse.json({ ok: false, error: "El email ya existe" }, { status: 409 });
    }

    const googleProjectId   = body.googleServiceAccountJson?.project_id  ?? body.googleProjectId!;
    const googleClientEmail = body.googleServiceAccountJson?.client_email ?? body.googleClientEmail!;
    const googlePrivateKey  = body.googleServiceAccountJson?.private_key  ?? body.googlePrivateKey!;

    const passwordHash = await hashPassword(body.password);
    const intervalMinutes = parseProcessIntervalMinutes(env.PROCESS_INTERVAL_MINUTES);

    const driveFoldersJson: Record<string, string> = {
      pending: body.driveFolderPending.trim(),
      scanned: body.driveFolderScanned.trim(),
    };
    if (body.driveFolderUnassigned?.trim()) driveFoldersJson.unassigned = body.driveFolderUnassigned.trim();
    if (body.driveFolderFailed?.trim())     driveFoldersJson.failed     = body.driveFolderFailed.trim();
    if (body.driveFolderReceipts?.trim())   driveFoldersJson.receipts   = body.driveFolderReceipts.trim();

    // Las API keys de IA se encriptan igual que la private key de Google
    const geminiApiKey = body.geminiApiKey?.trim();
    const openaiApiKey = body.openaiApiKey?.trim();
    const anthropicApiKey = body.anthropicApiKey?.trim();

    const client = await prisma.$transaction(async (tx) => {
      const created = await tx.client.create({
        data: {
          name: body.companyName,
          email: body.email.toLowerCase(),
          passwordHash,
          role: "CLIENT",
          isActive: true,
          driveFoldersJson: driveFoldersJson as Prisma.InputJsonValue,
          googleConfigJson: {
            projectId: googleProjectId,
            clientEmail: googleClientEmail,
            privateKey: encrypt(googlePrivateKey),
            sheetsId: body.sheetsId,
            ...(body.altaSheetsId ? { altaSheetsId: body.altaSheetsId } : {}),
          } as Prisma.InputJsonValue,
          extractionConfigJson: {
            sheetName: body.sheetName?.trim() || env.GOOGLE_SHEETS_SHEET_NAME,
            ...(geminiApiKey ? { geminiApiKey: encrypt(geminiApiKey) } : {}),
            ...(openaiApiKey ? { openaiApiKey: encrypt(openaiApiKey) } : {}),
            ...(anthropicApiKey ? { anthropicApiKey: encrypt(anthropicApiKey) } : {}),
          } as Prisma.InputJsonValue,
        },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          isActive: true,
          driveFoldersJson: true,
          createdAt: true,
        },
      });

      await tx.schedulerState.upsert({
        where: { clientId: created.id },
        create:  { clientId: created.id, enabled: true, intervalMinutes },
        update:  { enabled: true, intervalMinutes },
      });

      return created;
    });

    return NextResponse.json({ ok: true, client });
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
