import { NextResponse } from "next/server";
import { appConfig } from "@/lib/app";
import { getSessionSecret } from "@/lib/auth/crypto";
import { getDb } from "@/lib/db/server";
import { poppyOn } from "@/lib/flags";
import { clientIp, ipHash, readBody } from "@/lib/http";
import { logEvent } from "@/lib/log";
import { resolveClient } from "@/lib/oauth/clients";
import { redeemCode, refreshGrant, type TokenKeys, type TokenResult } from "@/lib/oauth/grants";
import { PUBLIC_CORS, oauthUrls } from "@/lib/oauth/metadata";
import { agentMetadata } from "@/lib/poppy/agent-metadata";
import { CLIENT_ASSERTION_TYPE, verifyClientAssertion } from "@/lib/poppy/jwt";

// The client ID a request names: the client_id field, or the assertion's issuer.
function namedClient(body: Record<string, string>) {
  if (body.client_id) return body.client_id;
  try {
    const payload = JSON.parse(
      Buffer.from((body.client_assertion ?? "").split(".")[1] ?? "", "base64url").toString(),
    );
    return typeof payload.iss === "string" ? payload.iss : undefined;
  } catch {
    return undefined;
  }
}

// Token endpoint (OAuth 2.1, FR30, FR45, controls M1, M3, PP7, PP9). MCP clients
// registered here: authorization_code with PKCE as public clients. With POPPY=on,
// Poppy agents authenticate with private_key_jwt and also get refresh tokens.
// Answers per RFC 6749 section 5.
export async function POST(request: Request) {
  const db = getDb();
  const secret = getSessionSecret();
  const origin = appConfig().appOrigin;
  const u = oauthUrls(origin);
  const json = (body: unknown, status = 200) =>
    NextResponse.json(body, { status, headers: { ...PUBLIC_CORS, Pragma: "no-cache" } });
  const fail = (error: string, description: string, status = 400) =>
    json({ error, error_description: description }, status);

  const body = await readBody(request).catch(() => ({}) as Record<string, string>);
  const poppy = poppyOn();
  const keys: TokenKeys = {
    secret,
    issuer: u.issuer,
    resource: poppy ? [u.resource, origin] : u.resource,
  };
  const clientId = namedClient(body);
  const client = await resolveClient(db, clientId);

  // A Poppy agent must prove its identity with a signed client assertion (Poppy 4.2).
  if (client?.kind === "poppy") {
    const assertion =
      body.client_assertion_type === CLIENT_ASSERTION_TYPE
        ? await verifyClientAssertion(
            db,
            body.client_assertion,
            client.metadata,
            u.issuer,
            agentMetadata.keys,
          )
        : null;
    if (!assertion) return fail("invalid_client", "Client authentication failed.", 401);
  }

  let result: TokenResult;
  if (body.grant_type === "authorization_code") {
    result = await redeemCode(
      db,
      {
        code: body.code,
        clientId: client?.clientId ?? clientId,
        redirectUri: body.redirect_uri,
        codeVerifier: body.code_verifier,
        resource: body.resource,
        issueRefresh: client?.kind === "poppy",
      },
      keys,
    );
  } else if (body.grant_type === "refresh_token" && poppy && client?.kind === "poppy") {
    result = await refreshGrant(
      db,
      {
        refreshToken: body.refresh_token,
        clientId: client.clientId,
        scope: body.scope,
        resource: body.resource,
      },
      keys,
    );
  } else {
    return fail(
      "unsupported_grant_type",
      poppy
        ? "Use authorization_code, or refresh_token for Poppy agents."
        : "Only authorization_code is supported.",
    );
  }

  await logEvent(db, {
    route: "mcp",
    method: "POST",
    pathOrTool: "oauth_token",
    outcome: result.ok ? "executed" : "blocked",
    reason: result.ok ? `token_issued:${body.grant_type}` : result.error,
    actorSignals: { clientId: clientId?.slice(0, 200) ?? null, clientKind: client?.kind ?? null },
    userAgent: (request.headers.get("user-agent") ?? "").slice(0, 300),
    ipHash: ipHash(clientIp(request), secret),
  });
  if (!result.ok) return fail(result.error, result.description);
  return json({
    access_token: result.accessToken,
    token_type: "Bearer",
    expires_in: result.expiresIn,
    scope: result.scope,
    ...(result.refreshToken ? { refresh_token: result.refreshToken } : {}),
  });
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: PUBLIC_CORS });
}
