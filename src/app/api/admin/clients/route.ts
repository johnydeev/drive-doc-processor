import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { env } from "@/config/env";
import { requireAdminSession } from "@/lib/adminAuth";
import { hashPassword } from "@/lib/password";
import { getPrismaClient } from "@/lib/prisma";
import { parseProcessIntervalMinutes } from "@/jobs/runProcessingCycle";

const bodySchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(8),
    companyName: z.string().min(2),
    driveFolderPending: z.string().min(5),
    driveFolderProcessed: z.string().min(5),
    sheetsId: z.string().min(10),
    sheetName: z.string().min(1).optional(),
    geminiApiKey: z
      .string()
      .trim()
      .optional()
      .refine((value) => !value || value.length >= 10, "geminiApiKey must be at least 10 characters"),
    openaiApiKey: z
      .string()
      .trim()
      .optional()
      .refine((value) => !value || value.length >= 10, "openaiApiKey must be at least 10 characters"),
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
        "Provide googleServiceAccountJson or googleProjectId/googleClientEmail/googlePrivateKey",
    }
  );

export async function POST(request: Request) {
  const auth = requireAdminSession(request);
  if (auth.error) {
    return auth.error;
  }

  try {
    const body = bodySchema.parse(await request.json());
    const prisma = getPrismaClient();

    const existing = await prisma.client.findUnique({
      where: { email: body.email.toLowerCase() },
      select: { id: true },
    });

    if (existing) {
      return NextResponse.json({ ok: false, error: "Email already exists" }, { status: 409 });
    }

    const googleProjectId = body.googleServiceAccountJson?.project_id ?? body.googleProjectId!;
    const googleClientEmail =
      body.googleServiceAccountJson?.client_email ?? body.googleClientEmail!;
    const googlePrivateKey = body.googleServiceAccountJson?.private_key ?? body.googlePrivateKey!;

    const passwordHash = await hashPassword(body.password);
    const intervalMinutes = parseProcessIntervalMinutes(env.PROCESS_INTERVAL_MINUTES);

    const client = await prisma.$transaction(async (tx) => {
      const created = await tx.client.create({
        data: {
          name: body.companyName,
          email: body.email.toLowerCase(),
          passwordHash,
          role: "CLIENT",
          isActive: true,
          driveFolderPending: body.driveFolderPending,
          driveFolderProcessed: body.driveFolderProcessed,
          googleConfigJson: {
            projectId: googleProjectId,
            clientEmail: googleClientEmail,
            privateKey: googlePrivateKey,
            sheetsId: body.sheetsId,
          } as Prisma.InputJsonValue,
          extractionConfigJson: {
            sheetName: body.sheetName?.trim() || env.GOOGLE_SHEETS_SHEET_NAME,
            geminiApiKey: body.geminiApiKey?.trim() || undefined,
            openaiApiKey: body.openaiApiKey?.trim() || undefined,
          } as Prisma.InputJsonValue,
        },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          isActive: true,
          driveFolderPending: true,
          driveFolderProcessed: true,
          createdAt: true,
        },
      });

      await tx.schedulerState.upsert({
        where: { clientId: created.id },
        create: {
          clientId: created.id,
          enabled: true,
          intervalMinutes,
        },
        update: {
          enabled: true,
          intervalMinutes,
        },
      });

      return created;
    });

    return NextResponse.json({ ok: true, client });
  } catch (error) {
    const message =
      error instanceof z.ZodError
        ? error.issues.map((issue) => issue.message).join(", ")
        : error instanceof Error
          ? error.message
          : "Unknown error";

    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}

