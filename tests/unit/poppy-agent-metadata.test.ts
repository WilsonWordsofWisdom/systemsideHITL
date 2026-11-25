// Poppy agent metadata checks (Poppy 1.0 section 4.1; FR45; control PP6).
import { describe, expect, it } from "vitest";
import {
  clientIdUrl,
  createAgentMetadata,
  loopbackClientsAllowed,
  validateJwks,
  validateMetadata,
} from "@/lib/poppy/agent-metadata";

const ID = "https://agent.example/oauth/client.json";
const good = {
  client_id: ID,
  client_name: "Example Agent",
  jwks_uri: "https://agent.example/jwks.json",
  redirect_uris: ["https://agent.example/callback", "http://127.0.0.1/cb"],
  token_endpoint_auth_method: "private_key_jwt",
};

describe("client ID metadata documents", () => {
  it("accepts a document that follows the rules", () => {
    expect(validateMetadata(new URL(ID), good, false)).toMatchObject({
      clientId: ID,
      name: "Example Agent",
      jwksUri: "https://agent.example/jwks.json",
    });
  });

  it.each([
    ["client_id differs from the URL", { client_id: "https://agent.example/other.json" }],
    ["jwks_uri on another host", { jwks_uri: "https://keys.example/jwks.json" }],
    ["jwks_uri over http", { jwks_uri: "http://agent.example/jwks.json" }],
    ["a redirect URI on another host", { redirect_uris: ["https://evil.example/cb"] }],
    ["no redirect URIs", { redirect_uris: [] }],
    ["another auth method", { token_endpoint_auth_method: "client_secret_basic" }],
  ])("refuses %s", (_label, over) => {
    expect(() => validateMetadata(new URL(ID), { ...good, ...over }, false)).toThrow();
  });

  it("only takes HTTPS client IDs without query or fragment", () => {
    expect(clientIdUrl(ID)).not.toBeNull();
    for (const bad of ["http://agent.example/c.json", `${ID}?x=1`, `${ID}#f`, "mcp_abc", ""]) {
      expect(clientIdUrl(bad), bad).toBeNull();
    }
    expect(clientIdUrl("http://localhost:4000/c.json")).toBeNull();
    expect(clientIdUrl("http://localhost:4000/c.json", true)).not.toBeNull();
  });

  it("allows loopback agents only in test mode on a localhost app", () => {
    const on = { POPPY_ALLOW_LOOPBACK_CLIENTS: "true" };
    expect(loopbackClientsAllowed(on, "http://localhost:3000")).toBe(true);
    expect(loopbackClientsAllowed(on, "https://hitltest.vercel.app")).toBe(false);
    expect(loopbackClientsAllowed({}, "http://localhost:3000")).toBe(false);
  });
});

describe("key sets", () => {
  it("keeps public EC P-256 and RSA keys, drops private or unknown ones", () => {
    const rsaN = "A".repeat(342); // about 2048 bits
    const keys = validateJwks({
      keys: [
        { kty: "EC", crv: "P-256", x: "x", y: "y", kid: "ec" },
        { kty: "EC", crv: "P-256", x: "x", y: "y", d: "secret", kid: "leaked" },
        { kty: "RSA", n: rsaN, e: "AQAB", kid: "rsa" },
        { kty: "RSA", n: "A".repeat(100), e: "AQAB", kid: "short" },
        { kty: "oct", k: "secret", kid: "hmac" },
      ],
    });
    expect(keys.map((k) => k.kid)).toEqual(["ec", "rsa"]);
  });
});

describe("caching", () => {
  it("refetches a key set for an unknown kid at most once per 30 seconds", async () => {
    let t = 0;
    let fetches = 0;
    const meta = createAgentMetadata({
      now: () => t,
      fetchJson: async () => {
        fetches++;
        return { keys: [{ kty: "EC", crv: "P-256", x: "x", y: "y", kid: "a" }] };
      },
    });
    await meta.keys("https://agent.example/jwks.json", "a");
    await meta.keys("https://agent.example/jwks.json", "b");
    expect(fetches).toBe(1);
    t = 31_000;
    await meta.keys("https://agent.example/jwks.json", "b");
    expect(fetches).toBe(2);
  });
});
