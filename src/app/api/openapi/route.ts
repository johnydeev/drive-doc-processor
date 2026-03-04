import { NextResponse } from "next/server";
import { openApiSpec } from "@/config/openapi";

export async function GET() {
  return NextResponse.json(openApiSpec, {
    headers: {
      "cache-control": "no-store",
    },
  });
}
