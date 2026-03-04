import { createHmac } from "crypto";
import { NextResponse } from "next/server";
import { ClientRole } from "@prisma/client";

export const AUTH_COOKIE_NAME = "dpp_session";
const DEFAULT_TTL_SECONDS = 60 * 60 * 24;

export interface AuthSessionPayload {
  clientId: string;
  email: string;
  role: ClientRole;
  exp: number;
}

interface BasePayload {
  clientId: string;
  email: string;
  role: ClientRole;
}

export function createSessionToken(
  payload: BasePayload,
  secret: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS
): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const fullPayload: AuthSessionPayload = {
    ...payload,
    exp,
  };

  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = toBase64Url(JSON.stringify(header));
  const encodedPayload = toBase64Url(JSON.stringify(fullPayload));
  const signature = sign(`${encodedHeader}.${encodedPayload}`, secret);
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

export function verifySessionToken(token: string, secret: string): AuthSessionPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }

  const [encodedHeader, encodedPayload, signature] = parts;
  const expected = sign(`${encodedHeader}.${encodedPayload}`, secret);
  if (signature !== expected) {
    return null;
  }

  try {
    const payload = JSON.parse(fromBase64Url(encodedPayload)) as AuthSessionPayload;
    if (!payload?.clientId || !payload?.email || !payload?.role || !payload?.exp) {
      return null;
    }

    if (payload.role !== "ADMIN" && payload.role !== "CLIENT") {
      return null;
    }

    const now = Math.floor(Date.now() / 1000);
    if (payload.exp <= now) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

export function setAuthCookie(
  response: NextResponse,
  payload: BasePayload,
  secret: string
): void {
  const token = createSessionToken(payload, secret, DEFAULT_TTL_SECONDS);
  response.cookies.set({
    name: AUTH_COOKIE_NAME,
    value: token,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    // Session cookie: removed when browser session ends.
    // Token still has its own 24h expiration (exp claim).
  });
}

export function clearAuthCookie(response: NextResponse): void {
  response.cookies.set({
    name: AUTH_COOKIE_NAME,
    value: "",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

export function readAuthTokenFromRequest(request: Request): string | null {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) {
    return null;
  }

  const cookies = cookieHeader.split(";");
  for (const rawCookie of cookies) {
    const [rawName, ...rawValueParts] = rawCookie.trim().split("=");
    if (rawName !== AUTH_COOKIE_NAME) {
      continue;
    }
    return rawValueParts.join("=") || null;
  }

  return null;
}

function sign(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

function toBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function fromBase64Url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}
