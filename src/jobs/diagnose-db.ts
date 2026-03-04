import dotenv from "dotenv";
import { getPrismaClient, isDatabaseConfigured } from "@/lib/prisma";

dotenv.config({ path: [".env.local", ".env"] });

async function run() {
  if (!isDatabaseConfigured()) {
    console.error("[diagnose:db] DATABASE_URL is not configured.");
    process.exit(1);
  }

  const prisma = getPrismaClient();
  const clientIdArg = process.argv[2];

  try {
    const [clientCount, invoiceCount, processingLogCount, tokenUsageCount] = await Promise.all([
      prisma.client.count(),
      prisma.invoice.count(),
      prisma.processingLog.count(),
      prisma.tokenUsage.count(),
    ]);

    const latestInvoices = await prisma.invoice.findMany({
      where: clientIdArg ? { clientId: clientIdArg } : undefined,
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        clientId: true,
        driveFileId: true,
        documentHash: true,
        isDuplicate: true,
        amount: true,
        createdAt: true,
      },
    });

    console.log("[diagnose:db] counts", {
      clients: clientCount,
      invoices: invoiceCount,
      processingLogs: processingLogCount,
      tokenUsage: tokenUsageCount,
    });

    console.log(
      "[diagnose:db] latestInvoices",
      latestInvoices.map((invoice) => ({
        id: invoice.id,
        clientId: invoice.clientId,
        driveFileId: invoice.driveFileId,
        hash: `${invoice.documentHash.slice(0, 8)}...${invoice.documentHash.slice(-8)}`,
        isDuplicate: invoice.isDuplicate,
        amount: invoice.amount?.toString() ?? null,
        createdAt: invoice.createdAt.toISOString(),
      }))
    );
  } catch (error) {
    console.error(
      "[diagnose:db] FAILED",
      error instanceof Error ? error.message : "Unknown error"
    );
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

void run();
