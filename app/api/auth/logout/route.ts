import { NextResponse } from "next/server";
import { appConfig } from "@/lib/app";
import { getSessionSecret } from "@/lib/auth/crypto";
import { SESSION_COOKIE, getCurrentSession } from "@/lib/auth/current";
import { revokeSession, verifyCsrf } from "@/lib/auth/session";
import { getDb } from "@/lib/db/server";
import { isSameOrigin, readBody, wantsHtml } from "@/lib/http";

export async function POST(request: Request) {
  const cfg = appConfig();
  const html = wantsHtml(request);
  if (!isSameOrigin(request, cfg.appOrigin)) {
    return NextResponse.json({ error: "bad_request" }, { status: 403 });
  }
  const current = await getCurrentSession();
  if (current) {
    const body = await readBody(request).catch(() => ({}) as Record<string, string>);
    const token = request.headers.get("x-csrf-token") ?? body.csrf;
    if (!verifyCsrf(current.session.id, token, getSessionSecret())) {
      return NextResponse.json({ error: "csrf" }, { status: 403 });
    }
    await revokeSession(getDb(), current.session.id, "signed_out");
  }
  const response = html
    ? NextResponse.redirect(new URL("/login?signed_out=1", cfg.appOrigin), 303)
    : NextResponse.json({ ok: true });
  response.cookies.delete(SESSION_COOKIE);
  return response;
}
