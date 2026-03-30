import { NextRequest, NextResponse } from "next/server";
import { requireClientSession } from "@/lib/clientAuth";
import { getPrismaClient } from "@/lib/prisma";
import { resolveGoogleConfig, resolveFolders } from "@/lib/clientProcessingConfig";
import { GoogleDriveService } from "@/services/googleDrive.service";

export async function POST(request: NextRequest) {
  const auth = requireClientSession(request);
  if (auth.error) return auth.error;

  try {
    const body = await request.json().catch(() => ({}));
    const fileIds: string[] | undefined = Array.isArray(body.fileIds) ? body.fileIds : undefined;

    const prisma = getPrismaClient();
    const client = await prisma.client.findUnique({ where: { id: auth.session.clientId } });
    if (!client) {
      return NextResponse.json({ ok: false, error: "Cliente no encontrado" }, { status: 404 });
    }

    const googleConfig = resolveGoogleConfig(client as any);
    if (!googleConfig) {
      return NextResponse.json({ ok: false, error: "Credenciales de Google incompletas" }, { status: 400 });
    }

    const folders = resolveFolders(client as any);
    if (!folders.unassigned || !folders.pending) {
      return NextResponse.json({ ok: false, error: "Carpetas no configuradas" }, { status: 400 });
    }

    const driveService = new GoogleDriveService(googleConfig);
    const allFiles = await driveService.listPdfFilesInFolder(folders.unassigned);

    const filesToMove = fileIds
      ? allFiles.filter((f) => fileIds.includes(f.id))
      : allFiles;

    let moved = 0;
    const errors: { id: string; name: string; error: string }[] = [];

    for (const file of filesToMove) {
      try {
        await driveService.moveFileToFolder(file.id, folders.unassigned, folders.pending);
        moved += 1;
      } catch (err) {
        errors.push({
          id: file.id,
          name: file.name,
          error: err instanceof Error ? err.message : "Unknown error",
        });
      }
    }

    return NextResponse.json({
      ok: true,
      moved,
      failed: errors.length,
      errors,
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
