import { NextResponse } from "next/server";
import { runProcessingCycle } from "@/jobs/runProcessingCycle";

export async function POST() {
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
