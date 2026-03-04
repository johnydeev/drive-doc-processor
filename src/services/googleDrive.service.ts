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
      "mimeType='application/pdf'",
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

  async moveFileToScanned(
    fileId: string,
    pendingFolderId: string = env.GOOGLE_DRIVE_PENDING_FOLDER_ID,
    scannedFolderId: string = env.GOOGLE_DRIVE_SCANNED_FOLDER_ID
  ): Promise<void> {
    await this.drive.files.update({
      fileId,
      addParents: scannedFolderId,
      removeParents: pendingFolderId,
      fields: "id, parents",
      supportsAllDrives: true,
    });
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
