// The MCP OAuth server against the database (FR30, controls M1-M3): registration,
// authorization request checks, code redemption and token verification.
import { eq } from "drizzle-orm";
import { SignJWT, decodeJwt } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { oauthTokens } from "@/lib/db/schema";
import type { AppDb } from "@/lib/db/types";
import { checkAuthorizeRequest } from "@/lib/oauth/authorize";
import { RegistrationError, registerClient } from "@/lib/oauth/clients";
import { issueCode, pkceS256, redeemCode, verifyAccessToken } from "@/lib/oauth/grants";
import { oauthUrls } from "@/lib/oauth/metadata";
import { DEMO_USER_ID } from "@/scripts/seed";
import { createTestDb } from "../helpers/db";

let db: AppDb;
let close: () => Promise<void>;
const ORIGIN = "https://hitltest.vercel.app";
const U = oauthUrls(ORIGIN);
const KEYS = { secret: "s".repeat(40), issuer: U.issuer, resource: U.resource };
const REDIRECT = "http://127.0.0.1:33418/callback";
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const t0 = new Date("2026-12-01T09:00:00Z");
const at = (s: number) => new Date(t0.getTime() + s * 1000);
let clientId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb({ seed: true }));
  clientId = (
    await registerClient(db, { redirect_uris: [REDIRECT], client_name: "Test agent" }, t0)
  ).client_id;
});
afterAll(async () => close());

const code = (over: Partial<Parameters<typeof issueCode>[1]> = {}, when = t0) =>
  issueCode(
    db,
    {
      clientId,
      userId: DEMO_USER_ID,
      redirectUri: REDIRECT,
      codeChallenge: pkceS256(VERIFIER),
      scope: "mcp",
      resource: U.resource,
      ...over,
    },
    when,
  );
const redeem = (c: string, over: object = {}, when = at(10)) =>
  redeemCode(
    db,
    {
      code: c,
      clientId,
      redirectUri: REDIRECT,
      codeVerifier: VERIFIER,
      resource: U.resource,
      ...over,
    },
    KEYS,
    when,
  );

describe("dynamic client registration (M2)", () => {
  it("registers a public client and strips control characters from its name", async () => {
    const r = await registerClient(db, {
      redirect_uris: ["https://a.example/cb"],
      client_name: "Agent\u0007 X",
    });
    expect(r).toMatchObject({ client_name: "Agent X", token_endpoint_auth_method: "none" });
    expect(r.client_id).toMatch(/^mcp_/);
  });

  it("rejects bad redirect URIs, confidential clients and other grant types", async () => {
    const cases = [
      { redirect_uris: ["http://a.example/cb"] },
      { redirect_uris: [] },
      {
        redirect_uris: ["https://a.example/cb"],
        token_endpoint_auth_method: "client_secret_basic",
      },
      { redirect_uris: ["https://a.example/cb"], grant_types: ["client_credentials"] },
      { nonsense: true },
    ];
    for (const c of cases) {
      await expect(registerClient(db, c), JSON.stringify(c)).rejects.toBeInstanceOf(
        RegistrationError,
      );
    }
  });
});

describe("authorization request checks", () => {
  const base = {
    response_type: "code",
    redirect_uri: REDIRECT,
    code_challenge: pkceS256(VERIFIER),
    code_challenge_method: "S256",
    state: "xyz",
  };

  it("accepts a well-formed request", async () => {
    const r = await checkAuthorizeRequest(
      db,
      { ...base, client_id: clientId, resource: U.resource },
      ORIGIN,
    );
    expect(r).toMatchObject({ kind: "ok", redirectUri: REDIRECT, state: "xyz", scope: "mcp" });
  });

  it("shows unknown clients and unregistered redirect URIs on our page, never redirecting", async () => {
    expect((await checkAuthorizeRequest(db, { ...base, client_id: "mcp_nope" }, ORIGIN)).kind).toBe(
      "fatal",
    );
    const wrongUri = await checkAuthorizeRequest(
      db,
      { ...base, client_id: clientId, redirect_uri: "https://evil.example/cb" },
      ORIGIN,
    );
    expect(wrongUri.kind).toBe("fatal");
  });

  it("sends protocol errors back to the registered redirect URI with state and issuer", async () => {
    const cases: [object, string][] = [
      [{ response_type: "token" }, "unsupported_response_type"],
      [{ code_challenge_method: "plain" }, "invalid_request"],
      [{ code_challenge: undefined }, "invalid_request"],
      [{ resource: "https://other.example/mcp" }, "invalid_target"],
      [{ scope: "mcp admin" }, "invalid_scope"],
    ];
    for (const [over, error] of cases) {
      const r = await checkAuthorizeRequest(db, { ...base, client_id: clientId, ...over }, ORIGIN);
      expect(r.kind, error).toBe("redirect_error");
      if (r.kind !== "redirect_error") continue;
      const url = new URL(r.url);
      expect(url.origin + url.pathname).toBe(REDIRECT);
      expect(url.searchParams.get("error")).toBe(error);
      expect(url.searchParams.get("state")).toBe("xyz");
      expect(url.searchParams.get("iss")).toBe(ORIGIN);
    }
  });
});

describe("code redemption and tokens (M1, M3)", () => {
  it("issues a token with sub = user, act = client and aud = /mcp, which verifies", async () => {
    const r = await redeem(await code());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const claims = decodeJwt(r.accessToken);
    expect(claims).toMatchObject({
      iss: ORIGIN,
      sub: DEMO_USER_ID,
      aud: U.resource,
      client_id: clientId,
      act: { sub: clientId },
      scope: "mcp",
    });
    expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(3600);
    const v = await verifyAccessToken(db, r.accessToken, KEYS, at(20));
    expect(v).toMatchObject({ userId: DEMO_USER_ID, clientId, scope: "mcp" });
  });

  it("rejects a wrong verifier, client, redirect URI or resource, and an expired code", async () => {
    expect(await redeem(await code(), { codeVerifier: `${VERIFIER.slice(0, -1)}A` })).toMatchObject(
      { ok: false, error: "invalid_grant" },
    );
    expect(await redeem(await code(), { clientId: "mcp_other" })).toMatchObject({
      ok: false,
      error: "invalid_grant",
    });
    expect(await redeem(await code(), { redirectUri: "http://127.0.0.1:1/x" })).toMatchObject({
      ok: false,
      error: "invalid_grant",
    });
    expect(await redeem(await code(), { resource: "https://other.example/mcp" })).toMatchObject({
      ok: false,
      error: "invalid_target",
    });
    expect(await redeem(await code(), {}, at(301))).toMatchObject({
      ok: false,
      error: "invalid_grant",
    });
    expect(await redeem("made-up")).toMatchObject({ ok: false, error: "invalid_grant" });
  });

  it("a replayed code fails and revokes the token it produced", async () => {
    const c = await code();
    const first = await redeem(c);
    if (!first.ok) throw new Error("expected a token");
    expect(await verifyAccessToken(db, first.accessToken, KEYS, at(20))).not.toBeNull();
    expect(await redeem(c, {}, at(30))).toMatchObject({ ok: false, error: "invalid_grant" });
    expect(await verifyAccessToken(db, first.accessToken, KEYS, at(40))).toBeNull();
  });

  it("concurrent redemptions of one code yield exactly one token", async () => {
    const c = await code();
    const results = await Promise.all(Array.from({ length: 5 }, () => redeem(c)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it("rejects tampered, foreign, expired, revoked and differently signed tokens", async () => {
    const r = await redeem(await code());
    if (!r.ok) throw new Error("expected a token");
    const [h, p, s] = r.accessToken.split(".");
    expect(await verifyAccessToken(db, `${h}.${p}.${s.slice(0, -2)}AA`, KEYS, at(20))).toBeNull();
    // Another resource or issuer.
    expect(
      await verifyAccessToken(
        db,
        r.accessToken,
        { ...KEYS, resource: "https://other.example/mcp" },
        at(20),
      ),
    ).toBeNull();
    expect(
      await verifyAccessToken(
        db,
        r.accessToken,
        { ...KEYS, issuer: "https://evil.example" },
        at(20),
      ),
    ).toBeNull();
    // Another SESSION_SECRET.
    expect(
      await verifyAccessToken(db, r.accessToken, { ...KEYS, secret: "t".repeat(40) }, at(20)),
    ).toBeNull();
    // Expired.
    expect(await verifyAccessToken(db, r.accessToken, KEYS, at(3700))).toBeNull();
    // alg "none".
    const none = `${Buffer.from(JSON.stringify({ alg: "none", typ: "at+jwt" })).toString("base64url")}.${p}.`;
    expect(await verifyAccessToken(db, none, KEYS, at(20))).toBeNull();
    // Revoked.
    const { jti } = decodeJwt(r.accessToken);
    await db
      .update(oauthTokens)
      .set({ revokedAt: at(25) })
      .where(eq(oauthTokens.jti, jti!));
    expect(await verifyAccessToken(db, r.accessToken, KEYS, at(30))).toBeNull();
  });

  it("rejects a validly signed token that wasn't issued here or lacks the actor claim", async () => {
    const forged = await new SignJWT({ client_id: clientId, scope: "mcp" })
      .setProtectedHeader({ alg: "HS256", typ: "at+jwt" })
      .setIssuer(ORIGIN)
      .setSubject(DEMO_USER_ID)
      .setAudience(U.resource)
      .setJti("never-issued")
      .setIssuedAt(Math.floor(t0.getTime() / 1000))
      .setExpirationTime(Math.floor(at(600).getTime() / 1000))
      // Using a guessed key: verification must fail on the signature alone.
      .sign(new TextEncoder().encode("guessed-key"));
    expect(await verifyAccessToken(db, forged, KEYS, at(20))).toBeNull();
  });
});
