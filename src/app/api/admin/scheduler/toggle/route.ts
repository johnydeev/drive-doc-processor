import { NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/config/env";
import { parseProcessIntervalMinutes } from "@/jobs/runProcessingCycle";
import { requireAuthenticatedSession } from "@/lib/adminAuth";
import { SchedulerControlService } from "@/services/schedulerControl.service";

const bodySchema = z.object({
  enabled: z.boolean(),
});

export async function POST(request: Request) {
  const auth = requireAuthenticatedSession(request);
  if (auth.error) {
    return auth.error;
  }

  if (auth.session.role === "ADMIN") {
    return NextResponse.json(
      {
        ok: false,
        error: "Admin cannot change scheduler state",
      },
      { status: 403 }
    );
  }

  try {
    const body = bodySchema.parse(await request.json());
    const controlService = new SchedulerControlService();
    const intervalMinutes = parseProcessIntervalMinutes(env.PROCESS_INTERVAL_MINUTES);
    const state = await controlService.setEnabled(body.enabled, intervalMinutes, auth.session.clientId);

    return NextResponse.json({ ok: true, state });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
