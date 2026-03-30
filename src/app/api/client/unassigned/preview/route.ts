import { NextRequest, NextResponse } from "next/server";
import { requireClientSession } from "@/lib/clientAuth";
import { getPrismaClient } from "@/lib/prisma";
import { resolveGoogleConfig, resolveFolders } from "@/lib/clientProcessingConfig";
import { GoogleDriveService } from "@/services/googleDrive.service";

export async function GET(request: NextRequest) {
  const auth = requireClientSession(request);
  if (auth.error) return auth.error;

  try {
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
    if (!folders.unassigned) {
      return NextResponse.json({ ok: true, files: [], folderConfigured: false, total: 0 });
    }

    const driveService = new GoogleDriveService(googleConfig);
    const files = await driveService.listPdfFilesInFolder(folders.unassigned);

    return NextResponse.json({
      ok: true,
      folderConfigured: true,
      files: files.map((f) => ({ id: f.id, name: f.name })),
      total: files.length,
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
