import { NextResponse } from "next/server";
import { env } from "@/config/env";
import { parseProcessIntervalMinutes } from "@/jobs/runProcessingCycle";
import { requireAuthenticatedSession } from "@/lib/adminAuth";
import { SchedulerControlService } from "@/services/schedulerControl.service";

export async function GET(request: Request) {
  const auth = requireAuthenticatedSession(request);
  if (auth.error) {
    return auth.error;
  }

  try {
    const controlService = new SchedulerControlService();
    const intervalMinutes = parseProcessIntervalMinutes(env.PROCESS_INTERVAL_MINUTES);
    const targetClientId = auth.session.role === "ADMIN" ? undefined : auth.session.clientId;
    const state = await controlService.getState(intervalMinutes, targetClientId);

    return NextResponse.json({
      ok: true,
      state,
      providers: {
        geminiConfigured: Boolean(env.GEMINI_API_KEY),
        openaiConfigured: Boolean(env.OPENAI_API_KEY),
      },
      auth: {
        email: auth.session.email,
        clientId: auth.session.clientId,
        role: auth.session.role,
      },
      scope: auth.session.role === "ADMIN" ? "all-clients" : "single-client",
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
