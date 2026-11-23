import { NextResponse } from "next/server";
import { appConfig } from "@/lib/app";
import { getSessionSecret } from "@/lib/auth/crypto";
import { getDb } from "@/lib/db/server";
import { clientIp, ipHash, readBody } from "@/lib/http";
import { logEvent } from "@/lib/log";
import { redeemCode } from "@/lib/oauth/grants";
import { PUBLIC_CORS, oauthUrls } from "@/lib/oauth/metadata";

// Token endpoint (OAuth 2.1, FR30, controls M1, M3): authorization_code with PKCE
// for public clients. Answers per RFC 6749 section 5.
export async function POST(request: Request) {
  const db = getDb();
  const secret = getSessionSecret();
  const origin = appConfig().appOrigin;
  const u = oauthUrls(origin);
  const json = (body: unknown, status = 200) =>
    NextResponse.json(body, { status, headers: { ...PUBLIC_CORS, Pragma: "no-cache" } });

  const body = await readBody(request).catch(() => ({}) as Record<string, string>);
  if (body.grant_type !== "authorization_code") {
    return json(
      {
        error: "unsupported_grant_type",
        error_description: "Only authorization_code is supported.",
      },
      400,
    );
  }
  const result = await redeemCode(
    db,
    {
      code: body.code,
      clientId: body.client_id,
      redirectUri: body.redirect_uri,
      codeVerifier: body.code_verifier,
      resource: body.resource,
    },
    { secret, issuer: u.issuer, resource: u.resource },
  );
  await logEvent(db, {
    route: "mcp",
    method: "POST",
    pathOrTool: "oauth_token",
    outcome: result.ok ? "executed" : "blocked",
    reason: result.ok ? "token_issued" : result.error,
    actorSignals: { clientId: body.client_id?.slice(0, 100) ?? null },
    userAgent: (request.headers.get("user-agent") ?? "").slice(0, 300),
    ipHash: ipHash(clientIp(request), secret),
  });
  if (!result.ok) {
    return json({ error: result.error, error_description: result.description }, 400);
  }
  return json({
    access_token: result.accessToken,
    token_type: "Bearer",
    expires_in: result.expiresIn,
    scope: result.scope,
  });
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: PUBLIC_CORS });
}
