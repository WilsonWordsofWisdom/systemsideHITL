// Poppy Direct Sign-In (J13; FR45; controls PP6-PP9): a Poppy agent identified by
// its client ID metadata document signs in with private_key_jwt, gets named scopes
// and a refresh token, rotates it, and can revoke the sign-in. A local HTTP server
// plays the agent (loopback agents are allowed only in test mode).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSession } from "@/lib/auth/session";
import type { AppDb } from "@/lib/db/types";
import { pkceS256, verifyAccessToken } from "@/lib/oauth/grants";
import { DEMO_USER_ID } from "@/scripts/seed";
import { createTestDb } from "../helpers/db";

vi.mock("server-only", () => ({}));

const ORIGIN = "http://localhost:3100";
const SECRET = "test-session-secret-0123456789abcdef";
process.env.APP_ORIGIN = ORIGIN;
process.env.RP_ID = "localhost";
process.env.SESSION_SECRET = SECRET;
process.env.POPPY = "on";
process.env.POPPY_ALLOW_LOOPBACK_CLIENTS = "true";

let db: AppDb;
let close: () => Promise<void>;
let server: Server;
let agentOrigin: string;
let clientId: string;
let privateKey: CryptoKey;
let publicJwk: JWK;

beforeAll(async () => {
  ({ db, close } = await createTestDb({ seed: true }));
  (globalThis as { __appDb?: AppDb }).__appDb = db;
  const pair = await generateKeyPair("ES256");
  privateKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" };
  server = createServer((req, res) => {
    const docs: Record<string, unknown> = {
      "/agent.json": {
        client_id: clientId,
        client_name: "Test Personal Agent",
        jwks_uri: `${agentOrigin}/jwks.json`,
        redirect_uris: [`${agentOrigin}/callback`],
        token_endpoint_auth_method: "private_key_jwt",
      },
      "/jwks.json": { keys: [publicJwk] },
    };
    const doc = docs[req.url ?? ""];
    res.writeHead(doc ? 200 : 404, { "content-type": "application/json" });
    res.end(doc ? JSON.stringify(doc) : "{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  agentOrigin = `http://localhost:${(server.address() as AddressInfo).port}`;
  clientId = `${agentOrigin}/agent.json`;
});
afterAll(async () => {
  delete (globalThis as { __appDb?: AppDb }).__appDb;
  await new Promise((r) => server.close(r));
  await close();
});

const assertion = (over: Record<string, unknown> = {}, expSeconds = 120) =>
  new SignJWT({ jti: crypto.randomUUID(), ...over })
    .setProtectedHeader({ alg: "ES256", kid: "k1" })
    .setIssuer(clientId)
    .setSubject(clientId)
    .setAudience((over.aud as string) ?? ORIGIN)
    .setIssuedAt()
    .setExpirationTime(`${expSeconds}s`)
    .sign(privateKey);

const form = (fields: Record<string, string>) =>
  new Request(`${ORIGIN}/api/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });

const verifier = "v".repeat(50);

async function signIn(scope = "applications:read applications:write applications:submit") {
  const { checkAuthorizeRequest } = await import("@/lib/oauth/authorize");
  const { issueCode } = await import("@/lib/oauth/grants");
  const check = await checkAuthorizeRequest(
    db,
    {
      response_type: "code",
      client_id: clientId,
      redirect_uri: `${agentOrigin}/callback`,
      code_challenge: pkceS256(verifier),
      code_challenge_method: "S256",
      scope,
      prompt: "consent",
    },
    ORIGIN,
  );
  if (check.kind !== "ok") throw new Error(`authorize: ${JSON.stringify(check)}`);
  expect(check.client.kind).toBe("poppy");
  expect(check.resource).toBe(ORIGIN);
  return issueCode(db, {
    clientId,
    userId: DEMO_USER_ID,
    redirectUri: check.redirectUri,
    codeChallenge: check.codeChallenge,
    scope: check.scope,
    resource: check.resource,
  });
}

const token = async (
  fields: Record<string, string>,
  withAssertion: Promise<string> | null = assertion(),
) => {
  const { POST } = await import("@/app/api/oauth/token/route");
  const res = await POST(
    form({
      client_id: clientId,
      ...(withAssertion
        ? {
            client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
            client_assertion: await withAssertion,
          }
        : {}),
      ...fields,
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, string> };
};

const keys = { secret: SECRET, issuer: ORIGIN, resource: [`${ORIGIN}/mcp`, ORIGIN] };

describe("authorization request", () => {
  it("needs named scopes we offer", async () => {
    const { checkAuthorizeRequest } = await import("@/lib/oauth/authorize");
    const base = {
      response_type: "code",
      client_id: clientId,
      redirect_uri: `${agentOrigin}/callback`,
      code_challenge: pkceS256(verifier),
      code_challenge_method: "S256",
    };
    for (const scope of [undefined, "mcp", "applications:read admin"]) {
      const check = await checkAuthorizeRequest(db, { ...base, scope }, ORIGIN);
      expect(check.kind, String(scope)).toBe("redirect_error");
      if (check.kind === "redirect_error") expect(check.url).toContain("error=invalid_scope");
    }
    const other = await checkAuthorizeRequest(
      db,
      { ...base, scope: "applications:read", redirect_uri: "https://evil.example/cb" },
      ORIGIN,
    );
    expect(other.kind).toBe("fatal");
  });
});

describe("token endpoint", () => {
  it("issues a domain-wide access token and a refresh token to an authenticated agent", async () => {
    const code = await signIn();
    const { status, body } = await token({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${agentOrigin}/callback`,
      code_verifier: verifier,
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({
      token_type: "Bearer",
      scope: "applications:read applications:write applications:submit",
    });
    expect(body.refresh_token).toMatch(/^prt_/);
    const verified = await verifyAccessToken(db, body.access_token, keys);
    expect(verified).toMatchObject({ userId: DEMO_USER_ID, clientId });
  });

  it("refuses an agent without a valid client assertion", async () => {
    const code = await signIn();
    const fields = {
      grant_type: "authorization_code",
      code,
      redirect_uri: `${agentOrigin}/callback`,
      code_verifier: verifier,
    };
    expect((await token(fields, null)).status).toBe(401);
    // aud must be the issuer itself, not the token endpoint.
    expect((await token(fields, assertion({ aud: `${ORIGIN}/api/oauth/token` }))).status).toBe(401);
    // At most 5 minutes long.
    expect((await token(fields, assertion({}, 600))).status).toBe(401);
    // A replayed assertion is refused.
    const once = assertion();
    const first = await token(fields, once);
    expect(first.status).toBe(200);
    expect((await token({ ...fields, code: await signIn() }, once)).status).toBe(401);
  });

  it("rotates refresh tokens; reusing one revokes the whole sign-in", async () => {
    const code = await signIn();
    const first = await token({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${agentOrigin}/callback`,
      code_verifier: verifier,
    });
    const second = await token({
      grant_type: "refresh_token",
      refresh_token: first.body.refresh_token,
    });
    expect(second.status).toBe(200);
    expect(second.body.refresh_token).not.toBe(first.body.refresh_token);
    expect(await verifyAccessToken(db, second.body.access_token, keys)).not.toBeNull();

    const reused = await token({
      grant_type: "refresh_token",
      refresh_token: first.body.refresh_token,
    });
    expect(reused).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
    expect(await verifyAccessToken(db, second.body.access_token, keys)).toBeNull();
    const after = await token({
      grant_type: "refresh_token",
      refresh_token: second.body.refresh_token,
    });
    expect(after.body.error).toBe("invalid_grant");
  });

  it("lets scope narrow at refresh, never widen", async () => {
    const code = await signIn("applications:read applications:write");
    const first = await token({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${agentOrigin}/callback`,
      code_verifier: verifier,
    });
    const wider = await token({
      grant_type: "refresh_token",
      refresh_token: first.body.refresh_token,
      scope: "applications:read payments",
    });
    expect(wider.body.error).toBe("invalid_scope");
    const narrower = await token({
      grant_type: "refresh_token",
      refresh_token: first.body.refresh_token,
      scope: "applications:read",
    });
    expect(narrower.body.scope).toBe("applications:read");
  });
});

describe("revocation and metadata", () => {
  it("revoking the refresh token signs the agent out", async () => {
    const code = await signIn();
    const t = await token({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${agentOrigin}/callback`,
      code_verifier: verifier,
    });
    const { POST } = await import("@/app/api/oauth/revoke/route");
    const res = await POST(
      new Request(`${ORIGIN}/api/oauth/revoke`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: t.body.refresh_token,
          token_type_hint: "refresh_token",
          client_id: clientId,
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: await assertion(),
        }).toString(),
      }),
    );
    expect(res.status).toBe(200);
    expect(await verifyAccessToken(db, t.body.access_token, keys)).toBeNull();
    const refreshed = await token({
      grant_type: "refresh_token",
      refresh_token: t.body.refresh_token,
    });
    expect(refreshed.body.error).toBe("invalid_grant");
  });

  it("publishes what Poppy requires of the authorization server", async () => {
    const { GET } = await import("@/app/.well-known/oauth-authorization-server/route");
    const meta = await GET().json();
    expect(meta).toMatchObject({
      issuer: ORIGIN,
      revocation_endpoint: `${ORIGIN}/api/oauth/revoke`,
      token_endpoint_auth_signing_alg_values_supported: ["ES256", "PS384"],
    });
    expect(meta.grant_types_supported).toContain("refresh_token");
    expect(meta.protected_resources).toContain(ORIGIN);
    expect(meta.scopes_supported).toContain("applications:submit");
  });
});

describe("MCP scopes", () => {
  it("a tool call needs the scope for its action", async () => {
    const code = await signIn("applications:read");
    const t = await token({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${agentOrigin}/callback`,
      code_verifier: verifier,
    });
    await createSession(db, { userId: DEMO_USER_ID, signinMethod: "password" });
    const { POST } = await import("@/app/mcp/route");
    const call = (name: string) =>
      POST(
        new Request(`${ORIGIN}/mcp`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${t.body.access_token}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2025-11-25",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name, arguments: { application_id: "x", declaration: true } },
          }),
        }),
      );
    const denied = await call("submit_application");
    expect(denied.status).toBe(403);
    expect(denied.headers.get("www-authenticate")).toContain(
      'error="insufficient_scope", scope="applications:submit"',
    );
    // A tool its scope covers gets through to the MCP server.
    expect((await call("list_applications")).status).not.toBe(403);
  });
});
