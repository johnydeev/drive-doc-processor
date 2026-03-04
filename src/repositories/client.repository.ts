import { Client } from "@prisma/client";
import { getPrismaClient } from "@/lib/prisma";
import { ClientGoogleConfig, ProcessingClient } from "@/types/client.types";

export class ClientRepository {
  async listActiveClients(): Promise<ProcessingClient[]> {
    const prisma = getPrismaClient();
    const rows = await prisma.client.findMany({
      where: {
        isActive: true,
        role: "CLIENT",
      },
      orderBy: { createdAt: "asc" },
    });

    return rows.map((row) => this.mapClient(row));
  }

  private mapClient(row: Client): ProcessingClient {
    return {
      id: row.id,
      name: row.name,
      isActive: row.isActive,
      driveFolderPending: row.driveFolderPending ?? "",
      driveFolderProcessed: row.driveFolderProcessed ?? "",
      googleConfigJson: (row.googleConfigJson as ClientGoogleConfig | null | undefined) ?? null,
      extractionConfigJson:
        (row.extractionConfigJson as Record<string, unknown> | null | undefined) ?? null,
    };
  }
}
