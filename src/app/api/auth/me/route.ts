import { NextResponse } from "next/server";
import { requireAuthenticatedSession } from "@/lib/adminAuth";
import { getPrismaClient } from "@/lib/prisma";

export async function GET(request: Request) {
  const auth = requireAuthenticatedSession(request);
  if (auth.error) {
    return auth.error;
  }

  try {
    const prisma = getPrismaClient();
    const user = await prisma.client.findUnique({
      where: { id: auth.session.clientId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        isActive: true,
      },
    });

    if (!user || !user.isActive) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    return NextResponse.json({ ok: true, user });
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
