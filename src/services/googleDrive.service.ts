import { google, drive_v3 } from "googleapis";
import { env } from "@/config/env";
import { ClientGoogleConfig } from "@/types/client.types";

export interface DrivePdfFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string | null;
  createdTime?: string | null;
  webViewLink?: string | null;
}

export interface DriveAnyFile {
  id: string;
  name: string;
  mimeType: string;
}

export interface DriveFileDiagnostics {
  id: string;
  name: string;
  mimeType: string;
  owners?: Array<{ displayName?: string | null; emailAddress?: string | null }> | null;
  capabilities?: drive_v3.Schema$File["capabilities"];
  shared?: boolean | null;
  ownedByMe?: boolean | null;
  driveId?: string | null;
}

export interface DriveUploadedFile {
  id: string;
  webViewLink: string | null;
}

export class GoogleDriveService {
  private drive: drive_v3.Drive;

  constructor(googleConfig?: ClientGoogleConfig | null) {
    const clientEmail = googleConfig?.clientEmail ?? env.GOOGLE_CLIENT_EMAIL;
    const privateKey = googleConfig?.privateKey ?? env.GOOGLE_PRIVATE_KEY;
    if (!clientEmail || !privateKey) {
      throw new Error("Missing Google Drive credentials. Configure client credentials in DB or GOOGLE_CLIENT_EMAIL/GOOGLE_PRIVATE_KEY.");
    }

    const auth = new google.auth.JWT({
      email: clientEmail,
      key: privateKey.replace(/\\n/g, "\n"),
      scopes: ["https://www.googleapis.com/auth/drive"],
    });

    this.drive = google.drive({ version: "v3", auth });
  }

  async listPendingPdfFiles(folderId: string = env.GOOGLE_DRIVE_PENDING_FOLDER_ID): Promise<DrivePdfFile[]> {
    return this.listPdfFilesInFolder(folderId);
  }

  async listPdfFilesInFolder(folderId: string): Promise<DrivePdfFile[]> {
    const q = [
      `'${folderId}' in parents`,
      "(mimeType='application/pdf' or mimeType='image/jpeg' or mimeType='image/png')",
      "trashed=false",
    ].join(" and ");

    const files = await this.listFiles({
      q,
      orderBy: "createdTime asc",
      fields: "nextPageToken,files(id,name,mimeType,modifiedTime,createdTime,webViewLink)",
    });

    return files
      .map((file) => ({
        id: file.id ?? "",
        name: file.name ?? "",
        mimeType: file.mimeType ?? "application/pdf",
        modifiedTime: file.modifiedTime,
        createdTime: file.createdTime,
        webViewLink: file.webViewLink,
      }))
      .filter((file) => file.id && file.name);
  }

  async listAllFilesInPending(folderId: string = env.GOOGLE_DRIVE_PENDING_FOLDER_ID): Promise<DriveAnyFile[]> {
    const q = [`'${folderId}' in parents`, "trashed=false"].join(" and ");

    const files = await this.listFiles({
      q,
      orderBy: "createdTime asc",
      fields: "nextPageToken,files(id,name,mimeType)",
    });

    return files
      .map((file) => ({
        id: file.id ?? "",
        name: file.name ?? "",
        mimeType: file.mimeType ?? "",
      }))
      .filter((file) => file.id && file.name);
  }

  async countPdfFilesInFolder(folderId: string): Promise<number> {
    const files = await this.listPdfFilesInFolder(folderId);
    return files.length;
  }

  async downloadFile(fileId: string): Promise<Buffer> {
    const response = await this.drive.files.get(
      { fileId, alt: "media", supportsAllDrives: true },
      { responseType: "arraybuffer" }
    );

    return Buffer.from(response.data as ArrayBuffer);
  }

  /**
   * Sube un archivo a Drive en la carpeta indicada.
   * Retorna el id y webViewLink del archivo creado.
   */
  async uploadFile(
    buffer: Buffer,
    fileName: string,
    mimeType: string,
    parentFolderId: string
  ): Promise<DriveUploadedFile> {
    const { Readable } = await import("stream");
    const stream = Readable.from(buffer);

    const response = await this.drive.files.create({
      requestBody: {
        name: fileName,
        parents: [parentFolderId],
      },
      media: {
        mimeType,
        body: stream,
      },
      fields: "id,webViewLink",
      supportsAllDrives: true,
    });

    return {
      id: response.data.id ?? "",
      webViewLink: response.data.webViewLink ?? null,
    };
  }

  /**
   * Busca una subcarpeta por nombre dentro de un padre.
   * Si no existe, la crea. Retorna el ID de la carpeta.
   */
  async getOrCreateFolder(folderName: string, parentFolderId: string): Promise<string> {
    // Buscar carpeta existente
    const q = [
      `'${parentFolderId}' in parents`,
      `name = '${folderName.replace(/'/g, "\\'")}'`,
      "mimeType = 'application/vnd.google-apps.folder'",
      "trashed = false",
    ].join(" and ");

    const existing = await this.listFiles({
      q,
      fields: "nextPageToken,files(id,name)",
    });

    if (existing.length > 0 && existing[0].id) {
      return existing[0].id;
    }

    // Crear si no existe
    const created = await this.drive.files.create({
      requestBody: {
        name: folderName,
        mimeType: "application/vnd.google-apps.folder",
        parents: [parentFolderId],
      },
      fields: "id",
      supportsAllDrives: true,
    });

    if (!created.data.id) {
      throw new Error(`No se pudo crear la carpeta "${folderName}" en Drive`);
    }

    return created.data.id;
  }

  /**
   * Moves a file from one folder to another.
   */
  async moveFileToFolder(
    fileId: string,
    fromFolderId: string,
    toFolderId: string
  ): Promise<void> {
    await this.drive.files.update({
      fileId,
      addParents: toFolderId,
      removeParents: fromFolderId,
      fields: "id, parents",
      supportsAllDrives: true,
    });
  }

  async moveFileToScanned(
    fileId: string,
    pendingFolderId: string = env.GOOGLE_DRIVE_PENDING_FOLDER_ID,
    scannedFolderId: string = env.GOOGLE_DRIVE_SCANNED_FOLDER_ID
  ): Promise<void> {
    await this.moveFileToFolder(fileId, pendingFolderId, scannedFolderId);
  }

  async moveFileToUnassigned(
    fileId: string,
    pendingFolderId: string,
    unassignedFolderId: string
  ): Promise<void> {
    await this.moveFileToFolder(fileId, pendingFolderId, unassignedFolderId);
  }

  async moveFileToFailed(
    fileId: string,
    pendingFolderId: string,
    failedFolderId: string
  ): Promise<void> {
    await this.moveFileToFolder(fileId, pendingFolderId, failedFolderId);
  }

  /**
   * Manda un archivo a la papelera (no borra definitivamente). Permite recuperarlo
   * desde la UI de Drive si fue un error. Usado por endpoints de eliminación.
   */
  async trashFile(fileId: string): Promise<void> {
    await this.drive.files.update({
      fileId,
      requestBody: { trashed: true },
      supportsAllDrives: true,
    });
  }

  /**
   * Devuelve los IDs de las carpetas padres actuales del archivo. Útil para mover
   * de "no sé dónde está" a una carpeta destino (calculás los `removeParents`).
   */
  async getFileParents(fileId: string): Promise<string[]> {
    const res = await this.drive.files.get({
      fileId,
      fields: "parents",
      supportsAllDrives: true,
    });
    return res.data.parents ?? [];
  }

  async getFileDiagnostics(fileId: string): Promise<DriveFileDiagnostics> {
    const response = await this.drive.files.get({
      fileId,
      supportsAllDrives: true,
      fields:
        "id,name,mimeType,owners(displayName,emailAddress),capabilities,shared,ownedByMe,driveId",
    });

    const file = response.data;
    return {
      id: file.id ?? "",
      name: file.name ?? "",
      mimeType: file.mimeType ?? "",
      owners: file.owners ?? null,
      capabilities: file.capabilities,
      shared: file.shared ?? null,
      ownedByMe: file.ownedByMe ?? null,
      driveId: (file as { driveId?: string | null }).driveId ?? null,
    };
  }

  private async listFiles(params: {
    q: string;
    fields: string;
    orderBy?: string;
  }): Promise<drive_v3.Schema$File[]> {
    const files: drive_v3.Schema$File[] = [];
    let pageToken: string | undefined;

    do {
      const response = await this.drive.files.list({
        q: params.q,
        fields: params.fields,
        orderBy: params.orderBy,
        pageToken,
        pageSize: 1000,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });

      if (response.data.files?.length) {
        files.push(...response.data.files);
      }

      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);

    return files;
  }
}
