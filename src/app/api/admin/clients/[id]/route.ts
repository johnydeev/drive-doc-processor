import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { requireAdminSession } from "@/lib/adminAuth";
import { getPrismaClient } from "@/lib/prisma";
import { encrypt } from "@/utils/encryption.util";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const auth = requireAdminSession(request);
  if (auth.error) return auth.error;

  const { id } = await context.params;
  const prisma = getPrismaClient();

  const client = await prisma.client.findUnique({ where: { id } });
  if (!client) {
    return NextResponse.json({ ok: false, error: "Cliente no encontrado" }, { status: 404 });
  }

  const google = (client.googleConfigJson ?? {}) as Record<string, unknown>;
  const extraction = (client.extractionConfigJson ?? {}) as Record<string, unknown>;
  const drive = (client.driveFoldersJson ?? {}) as Record<string, unknown>;

  return NextResponse.json({
    ok: true,
    client: {
      id: client.id,
      name: client.name,
      email: client.email,
      isActive: client.isActive,
      consortiumsEnabled: client.consortiumsEnabled,
      batchSize: client.batchSize,
      intervalMinutes: client.intervalMinutes,
      sheetsId: (google.sheetsId as string) ?? "",
      altaSheetsId: (google.altaSheetsId as string) ?? "",
      sheetName: (extraction.sheetName as string) ?? "",
      googleProjectId: (google.projectId as string) ?? "",
      googleClientEmail: (google.clientEmail as string) ?? "",
      driveFolderPending: (drive.pending as string) ?? "",
      driveFolderScanned: (drive.scanned as string) ?? "",
      driveFolderUnassigned: (drive.unassigned as string) ?? "",
      driveFolderFailed: (drive.failed as string) ?? "",
      driveFolderReceipts: (drive.receipts as string) ?? "",
      hasPrivateKey: Boolean(google.privateKey),
      hasGeminiApiKey: Boolean(extraction.geminiApiKey),
      hasOpenaiApiKey: Boolean(extraction.openaiApiKey),
      hasAnthropicApiKey: Boolean(extraction.anthropicApiKey),
    },
  });
}

const patchSchema = z.object({
  name: z.string().min(2).optional(),
  isActive: z.boolean().optional(),
  consortiumsEnabled: z.boolean().optional(),
  batchSize: z.number().int().min(1).max(500).optional(),
  intervalMinutes: z.number().int().min(1).max(1440).optional(),
  sheetsId: z.string().min(10).optional(),
  altaSheetsId: z.string().min(10).optional().nullable(),
  sheetName: z.string().min(1).optional(),
  googleProjectId: z.string().min(2).optional(),
  googleClientEmail: z.string().email().optional(),
  googlePrivateKey: z.string().min(50).optional(),
  driveFolderPending: z.string().min(5).optional(),
  driveFolderScanned: z.string().min(5).optional(),
  driveFolderUnassigned: z.string().optional().nullable(),
  driveFolderFailed: z.string().optional().nullable(),
  driveFolderReceipts: z.string().optional().nullable(),
  geminiApiKey: z.string().min(10).optional().nullable(),
  openaiApiKey: z.string().min(10).optional().nullable(),
  anthropicApiKey: z.string().min(10).optional().nullable(),
});

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const auth = requireAdminSession(request);
  if (auth.error) return auth.error;

  const { id } = await context.params;

  try {
    const prisma = getPrismaClient();

    const client = await prisma.client.findUnique({ where: { id } });
    if (!client) {
      return NextResponse.json({ ok: false, error: "Cliente no encontrado" }, { status: 404 });
    }

    const body = patchSchema.parse(await request.json());

    const google = (client.googleConfigJson ?? {}) as Record<string, unknown>;
    const extraction = (client.extractionConfigJson ?? {}) as Record<string, unknown>;
    const drive = (client.driveFoldersJson ?? {}) as Record<string, unknown>;

    // Merge google config
    if (body.sheetsId !== undefined) google.sheetsId = body.sheetsId;
    if (body.altaSheetsId !== undefined) {
      if (body.altaSheetsId) google.altaSheetsId = body.altaSheetsId;
      else delete google.altaSheetsId;
    }
    if (body.googleProjectId !== undefined) google.projectId = body.googleProjectId;
    if (body.googleClientEmail !== undefined) google.clientEmail = body.googleClientEmail;
    if (body.googlePrivateKey) google.privateKey = encrypt(body.googlePrivateKey);

    // Merge extraction config
    if (body.sheetName !== undefined) extraction.sheetName = body.sheetName;
    if (body.geminiApiKey !== undefined) {
      if (body.geminiApiKey) extraction.geminiApiKey = encrypt(body.geminiApiKey);
      else delete extraction.geminiApiKey;
    }
    if (body.openaiApiKey !== undefined) {
      if (body.openaiApiKey) extraction.openaiApiKey = encrypt(body.openaiApiKey);
      else delete extraction.openaiApiKey;
    }
    if (body.anthropicApiKey !== undefined) {
      if (body.anthropicApiKey) extraction.anthropicApiKey = encrypt(body.anthropicApiKey);
      else delete extraction.anthropicApiKey;
    }

    // Merge drive folders
    if (body.driveFolderPending !== undefined) drive.pending = body.driveFolderPending;
    if (body.driveFolderScanned !== undefined) drive.scanned = body.driveFolderScanned;
    if (body.driveFolderUnassigned !== undefined) drive.unassigned = body.driveFolderUnassigned ?? null;
    if (body.driveFolderFailed !== undefined) drive.failed = body.driveFolderFailed ?? null;
    if (body.driveFolderReceipts !== undefined) drive.receipts = body.driveFolderReceipts ?? null;

    const updated = await prisma.client.update({
      where: { id },
      data: {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.isActive !== undefined && { isActive: body.isActive }),
        ...(body.consortiumsEnabled !== undefined && { consortiumsEnabled: body.consortiumsEnabled }),
        ...(body.batchSize !== undefined && { batchSize: body.batchSize }),
        ...(body.intervalMinutes !== undefined && { intervalMinutes: body.intervalMinutes }),
        googleConfigJson: google as Prisma.InputJsonValue,
        extractionConfigJson: extraction as Prisma.InputJsonValue,
        driveFoldersJson: drive as Prisma.InputJsonValue,
      },
      select: { id: true, name: true, email: true, isActive: true },
    });

    return NextResponse.json({ ok: true, client: updated });
  } catch (err) {
    const message =
      err instanceof z.ZodError
        ? err.issues.map((i) => i.message).join(", ")
        : err instanceof Error
          ? err.message
          : "Error al actualizar";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
