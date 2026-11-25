import { NextResponse } from "next/server";
import { appConfig } from "@/lib/app";
import { getSessionSecret } from "@/lib/auth/crypto";
import { getDb } from "@/lib/db/server";
import { poppyOn } from "@/lib/flags";
import { clientIp, ipHash, readBody } from "@/lib/http";
import { logEvent } from "@/lib/log";
import { resolveClient } from "@/lib/oauth/clients";
import { revokeToken } from "@/lib/oauth/grants";
import { PUBLIC_CORS, oauthUrls } from "@/lib/oauth/metadata";
import { agentMetadata } from "@/lib/poppy/agent-metadata";
import { CLIENT_ASSERTION_TYPE, verifyClientAssertion } from "@/lib/poppy/jwt";
import { notFound } from "@/lib/poppy/version";

// RFC 7009 revocation (Poppy 1.0 section 5.5 sign-out; FR45, control PP9). Poppy
// agents authenticate with private_key_jwt; MCP clients registered here are public
// and name their client_id. A refresh token revokes the whole sign-in. Answers 200
// whether or not the token was known.
export async function POST(request: Request) {
  if (!poppyOn()) return notFound();
  const db = getDb();
  const secret = getSessionSecret();
  const u = oauthUrls(appConfig().appOrigin);
  const body = await readBody(request).catch(() => ({}) as Record<string, string>);
  const client = await resolveClient(db, body.client_id);
  if (!client) {
    return NextResponse.json({ error: "invalid_client" }, { status: 401, headers: PUBLIC_CORS });
  }
  if (client.kind === "poppy") {
    const ok =
      body.client_assertion_type === CLIENT_ASSERTION_TYPE &&
      (await verifyClientAssertion(
        db,
        body.client_assertion,
        client.metadata,
        u.issuer,
        agentMetadata.keys,
      ));
    if (!ok) {
      return NextResponse.json({ error: "invalid_client" }, { status: 401, headers: PUBLIC_CORS });
    }
  }
  const signIn = await revokeToken(db, body.token, client.clientId, secret);
  await logEvent(db, {
    route: "mcp",
    method: "POST",
    pathOrTool: "oauth_revoke",
    outcome: "executed",
    reason: signIn ? "sign_in_revoked" : "token_revoked",
    actorSignals: { clientId: client.clientId },
    userAgent: (request.headers.get("user-agent") ?? "").slice(0, 300),
    ipHash: ipHash(clientIp(request), secret),
  });
  return new NextResponse(null, {
    status: 200,
    headers: { ...PUBLIC_CORS, "Cache-Control": "no-store" },
  });
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: PUBLIC_CORS });
}
