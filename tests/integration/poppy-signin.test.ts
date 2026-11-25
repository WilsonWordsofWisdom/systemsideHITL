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

// Poppy Session JWTs (J13 T19; FR46; control PP5).
describe("Poppy Sessions", () => {
  const sidOf = () => `sid_${crypto.randomUUID().replace(/-/g, "")}`;

  async function sessionHeader(
    opts: {
      url?: string;
      method?: string;
      sid?: string;
      sub?: string;
      accessToken?: string;
      aud?: string;
      jti?: string;
      dlgSeconds?: number;
      dlgExpired?: boolean;
      badKid?: boolean;
      noDelegation?: boolean;
    } = {},
  ) {
    const { calculateJwkThumbprint } = await import("jose");
    const delegated = await generateKeyPair("ES256");
    const cnf = await exportJWK(delegated.publicKey);
    const now = Math.floor(Date.now() / 1000);
    const iat = opts.dlgExpired ? now - 3600 : now;
    const dlg = await new SignJWT({ cnf: { jwk: cnf }, jti: crypto.randomUUID() })
      .setProtectedHeader({ alg: "ES256", typ: "poppy-delegation+jwt", kid: "k1" })
      .setIssuer(clientId)
      .setIssuedAt(iat)
      .setExpirationTime(iat + (opts.dlgSeconds ?? 600))
      .sign(privateKey);
    const kid = opts.badKid ? "not-the-thumbprint" : await calculateJwkThumbprint(cnf);
    const { createHash } = await import("node:crypto");
    return new SignJWT({
      sid: opts.sid ?? sidOf(),
      sub: opts.sub ?? "pa-user-1",
      htm: opts.method ?? "POST",
      htu: opts.url ?? `${ORIGIN}/mcp`,
      jti: opts.jti ?? crypto.randomUUID(),
      ...(opts.accessToken
        ? { ath: createHash("sha256").update(opts.accessToken).digest("base64url") }
        : {}),
    })
      .setProtectedHeader({
        alg: "ES256",
        typ: "poppy-session+jwt",
        kid,
        ...(opts.noDelegation ? {} : { poppy_dlg: dlg }),
      })
      .setIssuer(clientId)
      .setAudience(opts.aud ?? ORIGIN)
      .setIssuedAt()
      .sign(delegated.privateKey);
  }

  const verify = async (header: string, token?: { value: string; userId?: string }) => {
    const { verifyPoppySession } = await import("@/lib/poppy/session");
    return verifyPoppySession(
      db,
      new Request(`${ORIGIN}/mcp?run=r1`, { method: "POST", headers: { "poppy-session": header } }),
      {
        origin: ORIGIN,
        token: token
          ? { value: token.value, clientId, userId: token.userId ?? DEMO_USER_ID }
          : null,
      },
    );
  };

  it("accepts a valid Session and links the agent's user ID to the account", async () => {
    const check = await verify(await sessionHeader({ accessToken: "tok-1" }), { value: "tok-1" });
    expect(check).toMatchObject({ ok: true, session: { clientId, sub: "pa-user-1" } });
    const { poppyLinks } = await import("@/lib/db/schema");
    const links = await db.select().from(poppyLinks);
    expect(links).toEqual([
      expect.objectContaining({ clientId, sub: "pa-user-1", userId: DEMO_USER_ID }),
    ]);
  });

  it.each([
    ["an expired delegation", { dlgExpired: true }],
    ["a delegation longer than 24 hours", { dlgSeconds: 25 * 3600 }],
    ["a kid that is not the delegated key's thumbprint", { badKid: true }],
    ["an htu for another URL", { url: `${ORIGIN}/api/poppy/tasks` }],
    ["another method", { method: "GET" }],
    ["another audience", { aud: "https://other.example" }],
    ["no delegation", { noDelegation: true }],
  ])("refuses %s with invalid_session", async (_label, opts) => {
    const check = await verify(await sessionHeader(opts));
    expect(check).toMatchObject({ ok: false, error: "invalid_session" });
  });

  it("refuses a replayed Session JWT", async () => {
    const header = await sessionHeader();
    expect((await verify(header))?.ok).toBe(true);
    expect(await verify(header)).toMatchObject({ ok: false, error: "invalid_session" });
  });

  it("checks ath against the access token on the same request", async () => {
    expect(
      await verify(await sessionHeader({ accessToken: "tok-a" }), { value: "tok-b" }),
    ).toMatchObject({
      ok: false,
    });
    expect(await verify(await sessionHeader({ accessToken: "tok-a" }))).toMatchObject({
      ok: false,
    });
    expect(await verify(await sessionHeader(), { value: "tok-a" })).toMatchObject({ ok: false });
  });

  it("keeps a Session's user ID, and an agent user ID on one account", async () => {
    const sid = sidOf();
    expect((await verify(await sessionHeader({ sid, sub: "pa-user-2" })))?.ok).toBe(true);
    expect(await verify(await sessionHeader({ sid, sub: "pa-user-3" }))).toMatchObject({
      ok: false,
      error: "invalid_session",
    });
    const { SECOND_USER_ID } = await import("@/scripts/seed");
    expect(
      await verify(await sessionHeader({ sub: "pa-user-1", accessToken: "tok-2" }), {
        value: "tok-2",
        userId: SECOND_USER_ID,
      }),
    ).toMatchObject({ ok: false, error: "session_ended" });
  });

  it("on /mcp: a bad Session is 400; a good one is logged as a Poppy agent", async () => {
    const code = await signIn("applications:read");
    const t = await token({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${agentOrigin}/callback`,
      code_verifier: verifier,
    });
    const { POST } = await import("@/app/mcp/route");
    const call = async (sessionJwt: string) =>
      POST(
        new Request(`${ORIGIN}/mcp`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${t.body.access_token}`,
            "poppy-session": sessionJwt,
            "poppy-version": "1.0",
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2025-11-25",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "list_applications", arguments: {} },
          }),
        }),
      );
    const bad = await call(await sessionHeader({ badKid: true, accessToken: t.body.access_token }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("invalid_session");

    const good = await call(
      await sessionHeader({ sub: "pa-mcp", accessToken: t.body.access_token }),
    );
    expect(good.status).toBe(200);
    // The response streams; the tool logs before its result is sent.
    expect(await good.text()).toContain('"isError":false');
    const { requestLog } = await import("@/lib/db/schema");
    const rows = await db.select().from(requestLog);
    const logged = rows.find(
      (r) =>
        r.pathOrTool === "list_applications" &&
        (r.actorSignals as { poppySession?: unknown }).poppySession,
    );
    expect(logged?.actorSignals).toMatchObject({
      facts: { protocolAgent: { source: "poppy_session", agent: clientId } },
      poppySession: { sub: "pa-mcp" },
    });
  });

  // Browser join (J13 T20; FR47): a declared handover to the agent's browser.
  describe("browser join", () => {
    const joinPage = async () => {
      const { GET } = await import("@/app/poppy/join/route");
      const res = await GET(
        new Request(`${ORIGIN}/poppy/join`, { headers: { "x-forwarded-for": "198.51.100.20" } }),
      );
      const html = await res.text();
      const code = /name="code" value="([^"]+)"/.exec(html)?.[1] ?? "";
      const cookie =
        /__Host-poppy_join=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? "";
      return { res, code, cookie };
    };

    const authorize = async (code: string, accessToken?: string, withSession = true) => {
      const { POST } = await import("@/app/poppy/join/authorize/route");
      const url = `${ORIGIN}/poppy/join/authorize`;
      return POST(
        new Request(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "poppy-version": "1.0",
            ...(withSession
              ? { "poppy-session": await sessionHeader({ url, sub: "pa-join", accessToken }) }
              : {}),
            ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
          },
          body: JSON.stringify({ code }),
        }),
      );
    };

    const submit = async (code: string, cookie: string) => {
      const { POST } = await import("@/app/poppy/join/route");
      return POST(
        new Request(`${ORIGIN}/poppy/join`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            origin: ORIGIN,
            cookie: `__Host-poppy_join=${cookie}`,
          },
          body: new URLSearchParams({ code }).toString(),
        }),
      );
    };

    const signedInToken = async (scope: string) => {
      const code = await signIn(scope);
      return token({
        grant_type: "authorization_code",
        code,
        redirect_uri: `${agentOrigin}/callback`,
        code_verifier: verifier,
      });
    };

    it("serves the join page with a short-lived __Host- cookie and no framing", async () => {
      const { res, code, cookie } = await joinPage();
      expect(res.status).toBe(200);
      expect(code).toMatch(/^bc_/);
      expect(cookie.length).toBeGreaterThan(20);
      const setCookie = res.headers.get("set-cookie") ?? "";
      expect(setCookie).toMatch(/Max-Age=60/);
      expect(setCookie).toMatch(/HttpOnly/);
      expect(setCookie).toMatch(/SameSite=strict/i);
      expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(res.headers.get("cache-control")).toBe("no-store");
    });

    it("needs a Session, and poppy:browser-sign-in to sign the browser in", async () => {
      const { code } = await joinPage();
      expect((await authorize(code, undefined, false)).status).toBe(400);
      const narrow = await signedInToken("applications:read");
      const denied = await authorize(code, narrow.body.access_token);
      expect(denied.status).toBe(403);
      expect(denied.headers.get("www-authenticate")).toContain("poppy:browser-sign-in");
      expect((await authorize("bc_unknown")).status).toBe(400);
    });

    it("a wrong cookie uses the code up", async () => {
      const { code, cookie } = await joinPage();
      expect((await authorize(code)).status).toBe(204);
      expect((await submit(code, "not-the-cookie")).status).toBe(400);
      expect((await submit(code, cookie)).status).toBe(400);
    });

    it("T20: a signed-in join starts a declared-agent session; the gate still holds; sign-out ends it", async () => {
      const t = await signedInToken("applications:read applications:submit poppy:browser-sign-in");
      const { code, cookie } = await joinPage();
      expect((await authorize(code, t.body.access_token)).status).toBe(204);
      const done = await submit(code, cookie);
      expect(done.status).toBe(303);
      expect(done.headers.get("location")).toBe(`${ORIGIN}/applications`);
      const sessionToken = /dg_session=([^;]+)/.exec(done.headers.get("set-cookie") ?? "")?.[1];
      expect(sessionToken).toBeTruthy();

      const { sessions } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");
      const { sha256Hex } = await import("@/lib/auth/crypto");
      const [joined] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, sha256Hex(sessionToken!)));
      expect(joined).toMatchObject({
        userId: DEMO_USER_ID,
        signinMethod: "poppy_join",
        declaredAgent: true,
        loginActorClass: "declared_agent",
      });

      // The joined browser asks to submit: gated like any agent, as a Poppy join.
      const { hitlGuard } = await import("@/lib/hitl/guard");
      const { createDraft, updateDraft } = await import("@/lib/journey/service");
      const app = await createDraft(db, DEMO_USER_ID, "Joined picnic");
      await updateDraft(db, DEMO_USER_ID, app.id, {
        date: "2026-12-12",
        attendance: "80",
        location: "Park",
      });
      const g = await hitlGuard({
        db,
        request: new Request(`${ORIGIN}/api/applications/x/submit`, { method: "POST" }),
        route: "api",
        userId: DEMO_USER_ID,
        session: joined,
        action: "submit_application",
        resourceId: app.id,
        body: { declaration: "on" },
        secret: SECRET,
        mode: "enforce",
        ttlSeconds: 600,
      });
      expect(g.kind).toBe("gated");
      expect(g.actor).toMatchObject({
        class: "declared_agent",
        tier: "A",
        facts: { protocolAgent: { source: "poppy_join", agent: clientId } },
      });

      // Revoking the sign-in signs the joined browser out too.
      const { POST } = await import("@/app/api/oauth/revoke/route");
      await POST(
        new Request(`${ORIGIN}/api/oauth/revoke`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            token: t.body.refresh_token,
            client_id: clientId,
            client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
            client_assertion: await assertion(),
          }).toString(),
        }),
      );
      const [after] = await db.select().from(sessions).where(eq(sessions.id, joined.id));
      expect(after.revokedAt).not.toBeNull();
    });
  });
});
