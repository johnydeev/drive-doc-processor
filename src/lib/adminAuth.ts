import { NextResponse } from "next/server";
import { ClientRole } from "@prisma/client";
import { env } from "@/config/env";
import { readAuthTokenFromRequest, verifySessionToken } from "@/lib/authSession";

export interface AuthenticatedSession {
  clientId: string;
  email: string;
  role: ClientRole;
}

export function requireAuthenticatedSession(
  request: Request
): { session: AuthenticatedSession; error: null } | { session: null; error: NextResponse } {
  const secret = env.SESSION_SECRET?.trim();
  if (!secret) {
    return {
      session: null,
      error: NextResponse.json(
        {
          ok: false,
          error: "SESSION_SECRET is not configured",
        },
        { status: 500 }
      ),
    };
  }

  const token = readAuthTokenFromRequest(request);
  if (!token) {
    return {
      session: null,
      error: NextResponse.json(
        {
          ok: false,
          error: "Unauthorized",
        },
        { status: 401 }
      ),
    };
  }

  const payload = verifySessionToken(token, secret);
  if (!payload) {
    return {
      session: null,
      error: NextResponse.json(
        {
          ok: false,
          error: "Unauthorized",
        },
        { status: 401 }
      ),
    };
  }

  return {
    session: {
      clientId: payload.clientId,
      email: payload.email,
      role: payload.role,
    },
    error: null,
  };
}

export function requireAdminSession(
  request: Request
): { session: AuthenticatedSession; error: null } | { session: null; error: NextResponse } {
  const auth = requireAuthenticatedSession(request);
  if (auth.error) {
    return auth;
  }

  if (auth.session.role !== "ADMIN") {
    return {
      session: null,
      error: NextResponse.json(
        {
          ok: false,
          error: "Forbidden",
        },
        { status: 403 }
      ),
    };
  }

  return auth;
}
