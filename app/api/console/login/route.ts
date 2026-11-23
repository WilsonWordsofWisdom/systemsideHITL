import { NextResponse } from "next/server";
import { appConfig } from "@/lib/app";
import { getSessionSecret } from "@/lib/auth/crypto";
import {
  ADMIN_COOKIE,
  ADMIN_LOGIN_LIMIT,
  ADMIN_TTL_MS,
  adminSecretMatches,
  getAdminSecret,
  makeAdminToken,
} from "@/lib/console/admin";
import { getDb } from "@/lib/db/server";
import { clientIp, ipHash, isSameOrigin, readBody } from "@/lib/http";
import { logEvent } from "@/lib/log";
import { clearFailures, lockedUntil, recordFailure } from "@/lib/ratelimit";

// Console sign-in with the admin secret (FR39, control L2). Rate limited per IP
// hash; every attempt is logged.
export async function POST(request: Request) {
  const cfg = appConfig();
  const back = (error?: string) =>
    NextResponse.redirect(
      new URL(error ? `/console?error=${error}` : "/console", cfg.appOrigin),
      303,
    );
  if (!isSameOrigin(request, cfg.appOrigin)) return back("bad_request");

  const adminSecret = getAdminSecret();
  if (!adminSecret) return back("not_configured");

  const db = getDb();
  const now = new Date();
  const key = getSessionSecret();
  const ip = ipHash(clientIp(request), key);
  const limitKey = `admin:ip:${ip}`;
  const log = (outcome: "executed" | "blocked", reason: string) =>
    logEvent(db, {
      route: "web",
      method: "POST",
      pathOrTool: "console_login",
      outcome,
      reason,
      userAgent: (request.headers.get("user-agent") ?? "").slice(0, 300),
      ipHash: ip,
    });

  if (await lockedUntil(db, limitKey, now)) {
    await log("blocked", "locked");
    return back("locked");
  }
  const body = await readBody(request).catch(() => ({}) as Record<string, string>);
  if (!adminSecretMatches(body.secret ?? "", adminSecret)) {
    const locked = await recordFailure(db, limitKey, ADMIN_LOGIN_LIMIT, now);
    await log("blocked", locked ? "locked" : "wrong_secret");
    return back(locked ? "locked" : "invalid");
  }
  await clearFailures(db, limitKey);
  await log("executed", "console_signin");

  const response = back();
  response.cookies.set(ADMIN_COOKIE, makeAdminToken(key, adminSecret, now), {
    httpOnly: true,
    secure: cfg.appOrigin.startsWith("https://"),
    sameSite: "strict",
    path: "/",
    maxAge: ADMIN_TTL_MS / 1000,
  });
  return response;
}
