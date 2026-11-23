// OAuth building blocks for /mcp (FR30, controls M1-M3): redirect URI rules, PKCE,
// metadata shapes, the sign-in return path and authorization redirects.
import {
  OAuthMetadataSchema,
  OAuthProtectedResourceMetadataSchema,
} from "@modelcontextprotocol/core";
import { describe, expect, it } from "vitest";
import { authorizationRedirect, safeNextPath } from "@/lib/oauth/authorize";
import { redirectUriProblem } from "@/lib/oauth/clients";
import { pkceMatches, pkceS256, validChallenge } from "@/lib/oauth/grants";
import { authorizationServerMetadata, protectedResourceMetadata } from "@/lib/oauth/metadata";

const ORIGIN = "https://hitltest.vercel.app";

describe("redirect URIs (M2)", () => {
  it("allows https and loopback http only", () => {
    for (const ok of [
      "https://client.example/callback",
      "http://127.0.0.1:33418/callback",
      "http://localhost:6274/oauth/callback",
      "http://[::1]:8080/cb",
    ]) {
      expect(redirectUriProblem(ok), ok).toBeNull();
    }
    for (const bad of [
      "http://client.example/callback",
      "javascript:alert(1)",
      "https://client.example/cb#frag",
      "https://user:pass@client.example/cb",
      "not a url",
      "ftp://127.0.0.1/cb",
    ]) {
      expect(redirectUriProblem(bad), bad).not.toBeNull();
    }
  });
});

describe("PKCE S256 (M1)", () => {
  // RFC 7636 appendix B test vector.
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

  it("matches the RFC 7636 test vector", () => {
    expect(pkceS256(verifier)).toBe(challenge);
    expect(pkceMatches(verifier, challenge)).toBe(true);
    expect(validChallenge(challenge)).toBe(true);
  });

  it("rejects a wrong, short, missing or plain verifier", () => {
    expect(pkceMatches(`${verifier.slice(0, -1)}A`, challenge)).toBe(false);
    expect(pkceMatches("short", pkceS256("short"))).toBe(false);
    expect(pkceMatches(undefined, challenge)).toBe(false);
    // "plain" method: the challenge equal to the verifier must not pass.
    expect(pkceMatches(verifier, verifier)).toBe(false);
    expect(validChallenge("not-a-challenge")).toBe(false);
  });
});

describe("metadata (RFC 8414, RFC 9728)", () => {
  it("authorization server metadata is valid and offers only code + S256 for public clients", () => {
    const m = OAuthMetadataSchema.parse(authorizationServerMetadata(ORIGIN));
    expect(m.issuer).toBe(ORIGIN);
    expect(m.response_types_supported).toEqual(["code"]);
    expect(m.code_challenge_methods_supported).toEqual(["S256"]);
    expect(m.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(m.registration_endpoint).toBe(`${ORIGIN}/api/oauth/register`);
  });

  it("protected resource metadata names /mcp and this server", () => {
    const m = OAuthProtectedResourceMetadataSchema.parse(protectedResourceMetadata(ORIGIN));
    expect(m.resource).toBe(`${ORIGIN}/mcp`);
    expect(m.authorization_servers).toEqual([ORIGIN]);
  });
});

describe("sign-in return path", () => {
  it("returns only to the authorization page", () => {
    expect(safeNextPath("/oauth/authorize?client_id=x")).toBe("/oauth/authorize?client_id=x");
    for (const bad of [
      "/applications",
      "https://evil.example/oauth/authorize?x",
      "//evil.example",
      "/oauth/authorize?\\evil",
      undefined,
      5,
    ]) {
      expect(safeNextPath(bad), String(bad)).toBeNull();
    }
  });
});

describe("authorization redirect", () => {
  it("adds the parameters and the issuer, dropping empty values", () => {
    const url = new URL(
      authorizationRedirect("http://127.0.0.1:9/cb?keep=1", { code: "abc", state: null }, ORIGIN),
    );
    expect(url.searchParams.get("keep")).toBe("1");
    expect(url.searchParams.get("code")).toBe("abc");
    expect(url.searchParams.has("state")).toBe(false);
    expect(url.searchParams.get("iss")).toBe(ORIGIN);
  });
});
