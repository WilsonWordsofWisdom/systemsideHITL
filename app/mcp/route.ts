import { createMcpHandler, type McpRequestContext } from "@modelcontextprotocol/server";
import { NextResponse } from "next/server";
import { appConfig } from "@/lib/app";
import { getSessionSecret } from "@/lib/auth/crypto";
import { validRunId } from "@/lib/console/run";
import { getDb } from "@/lib/db/server";
import { ensureMcpSession } from "@/lib/mcp/session";
import { buildMcpServer } from "@/lib/mcp/tools";
import { getClient } from "@/lib/oauth/clients";
import { verifyAccessToken } from "@/lib/oauth/grants";
import { oauthUrls } from "@/lib/oauth/metadata";

export const dynamic = "force-dynamic";

// Streamable HTTP MCP endpoint (FR29, FR31, controls M1, M4). Revision 2026-07-28
// and the 2025 revisions are served from one factory (decision 2026-11-23). Every
// request needs a bearer token issued by this app for this resource; tools then run
// as the token's user, with the OAuth client as the declared agent.
const handler = createMcpHandler(
  (ctx: McpRequestContext) => {
    const extra = ctx.authInfo?.extra as { caller?: Parameters<typeof buildMcpServer>[0] };
    if (!extra?.caller) throw new Error("MCP request without a verified caller");
    return buildMcpServer(extra.caller);
  },
  { legacy: "stateless" },
);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id, MCP-Protocol-Version",
};

function unauthorized(origin: string, invalid: boolean) {
  const metadata = oauthUrls(origin).resourceMetadata;
  const challenge = `Bearer resource_metadata="${metadata}"${invalid ? ', error="invalid_token"' : ""}`;
  return NextResponse.json(
    { error: invalid ? "invalid_token" : "unauthorized" },
    { status: 401, headers: { ...CORS, "WWW-Authenticate": challenge } },
  );
}

async function serve(request: Request) {
  const cfg = appConfig();
  const secret = getSessionSecret();
  const db = getDb();
  const header = request.headers.get("authorization") ?? "";
  const token = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim();
  if (!token) return unauthorized(cfg.appOrigin, false);
  const u = oauthUrls(cfg.appOrigin);
  const verified = await verifyAccessToken(db, token, {
    secret,
    issuer: u.issuer,
    resource: u.resource,
  });
  if (!verified) return unauthorized(cfg.appOrigin, true);

  const client = await getClient(db, verified.clientId);
  const session = await ensureMcpSession(db, {
    secret,
    clientId: verified.clientId,
    clientName: client?.name ?? verified.clientId,
    userId: verified.userId,
    tokenExpiresAt: verified.expiresAt,
    // A tester can tag a run by adding ?run=<id> to the MCP server URL (FR40).
    runId: validRunId(new URL(request.url).searchParams.get("run")),
  });
  const response = await handler.fetch(request, {
    authInfo: {
      token,
      clientId: verified.clientId,
      scopes: verified.scope.split(" "),
      expiresAt: Math.floor(verified.expiresAt.getTime() / 1000),
      resource: new URL(u.resource),
      extra: {
        caller: {
          db,
          request,
          origin: cfg.appOrigin,
          userId: verified.userId,
          session,
          clientId: verified.clientId,
          secret,
          mode: cfg.hitlMode,
          ttlSeconds: cfg.ticketTtlSeconds,
        },
      },
    },
  });
  for (const [k, v] of Object.entries(CORS)) response.headers.set(k, v);
  return response;
}

export const POST = serve;
export const GET = serve;
export const DELETE = serve;
export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
