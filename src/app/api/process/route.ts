import { NextRequest, NextResponse } from "next/server";
import { runProcessingCycle } from "@/jobs/runProcessingCycle";
import { requireAdminSession } from "@/lib/adminAuth";

export async function POST(req: NextRequest) {
  const auth = requireAdminSession(req);
  if (auth.error) return auth.error;

  try {
    const summary = await runProcessingCycle("manual", { ignoreEnabled: true });
    return NextResponse.json({ ok: true, summary });
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
