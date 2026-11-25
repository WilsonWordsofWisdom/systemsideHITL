import { NextResponse } from "next/server";
import { getSessionSecret } from "@/lib/auth/crypto";
import { getDb } from "@/lib/db/server";
import { clientIp, ipHash } from "@/lib/http";
import { logEvent } from "@/lib/log";
import { RegistrationError, registerClient } from "@/lib/oauth/clients";
import { PUBLIC_CORS } from "@/lib/oauth/metadata";
import { lockedUntil, recordFailure, retryAfter, type LimitRule } from "@/lib/ratelimit";

// Registrations per IP hash: generous for testers, a brake on floods.
const REGISTER_LIMIT: LimitRule = { max: 30, windowSec: 3600, lockSec: 3600 };
const MAX_BODY = 8 * 1024;

// Dynamic client registration (RFC 7591, FR30, control M2).
export async function POST(request: Request) {
  const db = getDb();
  const now = new Date();
  const ip = ipHash(clientIp(request), getSessionSecret());
  const key = `oauth:register:${ip}`;
  const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
    NextResponse.json(body, { status, headers: { ...PUBLIC_CORS, ...headers } });

  const until = await lockedUntil(db, key, now);
  if (until) {
    return json(
      { error: "invalid_client_metadata", error_description: "Too many registrations." },
      429,
      { "Retry-After": retryAfter(until, now, REGISTER_LIMIT.lockSec) },
    );
  }
  await recordFailure(db, key, REGISTER_LIMIT, now);
  const text = await request.text().catch(() => "");
  let raw: unknown;
  try {
    raw = text.length <= MAX_BODY ? JSON.parse(text) : null;
  } catch {
    raw = null;
  }
  try {
    const registered = await registerClient(db, raw, now);
    await logEvent(db, {
      route: "mcp",
      method: "POST",
      pathOrTool: "oauth_register",
      outcome: "executed",
      reason: "client_registered",
      actorSignals: { clientId: registered.client_id, clientName: registered.client_name },
      userAgent: (request.headers.get("user-agent") ?? "").slice(0, 300),
      ipHash: ip,
    });
    return json(registered, 201);
  } catch (err) {
    if (err instanceof RegistrationError) {
      return json({ error: err.error, error_description: err.description }, 400);
    }
    throw err;
  }
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: PUBLIC_CORS });
}
