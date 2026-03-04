import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/adminAuth";
import { getPrismaClient } from "@/lib/prisma";

export async function GET(request: Request) {
  const auth = requireAdminSession(request);
  if (auth.error) {
    return auth.error;
  }

  try {
    const prisma = getPrismaClient();
    const clients = await prisma.client.findMany({
      where: {
        role: "CLIENT",
      },
      orderBy: {
        createdAt: "asc",
      },
      select: {
        id: true,
        name: true,
        schedulerStates: {
          take: 1,
          select: {
            enabled: true,
            isRunning: true,
            totalRuns: true,
            totalFound: true,
            totalProcessed: true,
            totalDuplicates: true,
            totalFailed: true,
            totalTokens: true,
            quotaGeminiStatus: true,
            quotaOpenAiStatus: true,
          },
        },
      },
    });

    return NextResponse.json({
      ok: true,
      clients: clients.map((client) => {
        const state = client.schedulerStates[0];
        return {
          clientId: client.id,
          name: client.name,
          scheduler: {
            enabled: state?.enabled ?? false,
            isRunning: state?.isRunning ?? false,
          },
          totals: {
            runs: state?.totalRuns ?? 0,
            found: state?.totalFound ?? 0,
            processed: state?.totalProcessed ?? 0,
            duplicates: state?.totalDuplicates ?? 0,
            failed: state?.totalFailed ?? 0,
          },
          tokensUsed: state?.totalTokens ?? 0,
          quota: {
            gemini: state?.quotaGeminiStatus ?? "unknown",
            openai: state?.quotaOpenAiStatus ?? "unknown",
          },
        };
      }),
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
