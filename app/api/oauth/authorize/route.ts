import { NextResponse } from "next/server";
import { appConfig } from "@/lib/app";
import { getSessionSecret } from "@/lib/auth/crypto";
import { getCurrentSession } from "@/lib/auth/current";
import { verifyCsrf } from "@/lib/auth/session";
import { getDb } from "@/lib/db/server";
import { clientIp, ipHash, isSameOrigin, readBody } from "@/lib/http";
import { logEvent } from "@/lib/log";
import {
  authorizationRedirect,
  checkAuthorizeRequest,
  pickAuthorizeParams,
} from "@/lib/oauth/authorize";
import { issueCode } from "@/lib/oauth/grants";
import { oauthUrls } from "@/lib/oauth/metadata";

// Returns to the client's redirect URI from a tiny page of our own rather than a
// redirect: the consent form's CSP (form-action 'self') also governs redirects
// after a form submission, and this keeps the code out of our own URLs.
function returnToClient(url: string, clientName: string) {
  const escape = (v: string) =>
    v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const href = escape(url);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><meta http-equiv="refresh" content="0;url=${href}"><title>Returning to ${escape(clientName)}</title></head><body><p>Returning to ${escape(clientName)}. <a href="${href}">Continue</a></p></body></html>`;
  return new NextResponse(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    },
  });
}

// The consent decision (FR30, control M3). Same origin, signed-in user (not an
// approval-only session) and CSRF; the request is validated again here.
export async function POST(request: Request) {
  const origin = appConfig().appOrigin;
  if (!isSameOrigin(request, origin)) {
    return NextResponse.json({ error: "bad_request" }, { status: 403 });
  }
  const current = await getCurrentSession();
  if (!current || current.session.approvalOnly) {
    return NextResponse.redirect(new URL("/login", origin), 303);
  }
  const secret = getSessionSecret();
  const body = await readBody(request).catch(() => ({}) as Record<string, string>);
  if (!verifyCsrf(current.session.id, body.csrf, secret)) {
    return NextResponse.json({ error: "csrf" }, { status: 403 });
  }
  const db = getDb();
  const check = await checkAuthorizeRequest(db, pickAuthorizeParams(body), origin);
  if (check.kind === "fatal")
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  if (check.kind === "redirect_error") return returnToClient(check.url, "the application");

  const allow = body.decision === "allow";
  await logEvent(db, {
    route: "web",
    method: "POST",
    pathOrTool: "oauth_consent",
    userId: current.user.id,
    sessionId: current.session.id,
    runId: current.session.runId,
    outcome: "executed",
    reason: allow ? "consent_granted" : "consent_denied",
    actorSignals: { clientId: check.client.clientId, clientName: check.client.name },
    userAgent: (request.headers.get("user-agent") ?? "").slice(0, 300),
    ipHash: ipHash(clientIp(request), secret),
  });
  const issuer = oauthUrls(origin).issuer;
  if (!allow) {
    return returnToClient(
      authorizationRedirect(
        check.redirectUri,
        { error: "access_denied", state: check.state },
        issuer,
      ),
      check.client.name,
    );
  }
  const code = await issueCode(db, {
    clientId: check.client.clientId,
    userId: current.user.id,
    redirectUri: check.redirectUri,
    codeChallenge: check.codeChallenge,
    scope: check.scope,
    resource: check.resource,
  });
  return returnToClient(
    authorizationRedirect(check.redirectUri, { code, state: check.state }, issuer),
    check.client.name,
  );
}
