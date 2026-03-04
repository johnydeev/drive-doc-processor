import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json(
    {
      ok: false,
      error: "Public registration is disabled. Use /api/admin/clients as ADMIN.",
    },
    { status: 403 }
  );
}

