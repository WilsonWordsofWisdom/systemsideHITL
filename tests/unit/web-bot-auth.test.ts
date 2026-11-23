// Web Bot Auth verification against published test vectors (FR37, controls A4,
// A5): RFC 9421 appendix B.2.6 and draft-ietf-webbotauth-httpsig-protocol-01
// appendix E.2. Ed25519 is deterministic, so signatures we make must match exactly.
import { createPrivateKey, sign } from "node:crypto";
import { parseDictionary, type InnerList } from "structured-headers";
import { describe, expect, it } from "vitest";
import {
  jwkThumbprint,
  signatureBase,
  verifyWebBotAuth,
  type VerifyOptions,
} from "@/lib/webBotAuth";
import {
  TEST_KEY_X,
  createKeyResolver,
  directoryUrlProblem,
  isPublicAddress,
  type Ed25519Jwk,
} from "@/lib/webBotAuthDirectory";

// RFC 9421 B.1.4 test-key-ed25519.
const TEST_JWK: Ed25519Jwk = { kty: "OKP", crv: "Ed25519", x: TEST_KEY_X };
const TEST_PRIVATE = createPrivateKey({
  key: { ...TEST_JWK, d: "n4Ni-HpISpVObnQMW0wOhCKROaIKqKtW_2ZYb2p9KcU" },
  format: "jwk",
});
const KEYID = "poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U";
const ORIGIN = "https://example.com";
const AGENT = "https://signature-agent.test";
const resolveTestKey: VerifyOptions["resolveKey"] = async (url, keyid) =>
  url === AGENT && keyid === KEYID ? TEST_JWK : null;

// RFC 9421 test-request.
function testRequest(headers: Record<string, string> = {}) {
  return new Request("https://example.com/foo?param=Value&Pet=dog", {
    method: "POST",
    headers: {
      date: "Tue, 20 Apr 2021 02:07:55 GMT",
      "content-type": "application/json",
      "content-length": "18",
      ...headers,
    },
    body: '{"hello": "world"}',
  });
}

const E21 = {
  "signature-agent": `sig2="${AGENT}"`,
  "signature-input":
    'sig2=("@authority" "signature-agent";key="sig2");created=1735689600;keyid="poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U";alg="ed25519";expires=4889289600;nonce="n9p433xm+NJ3ph3upfBIGmsuwHw387YV7Q/F+6BSpGCVjYCqQw6rznNA8PVVLySrAWsv0hQtFioQb6E1YsauiA==";tag="web-bot-auth"',
  signature:
    "sig2=:CGokAoY/FrPpyuzTe1Fb2kLTAH9Idw6qSFd1+D77r1firsMRCxeuLu5e6O+ek3zQgDMAzjiXtLVfqE00xnABCQ==:",
};
const E22 = {
  "signature-agent": `"${AGENT}"`,
  "signature-input":
    'sig2=("@authority" "signature-agent");created=1735689600;keyid="poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U";alg="ed25519";expires=1735693200;nonce="e8N7S2MFd/qrd6T2R3tdfAuuANngKI7LFtKYI/vowzk4lAZYadIX6wW25MwG7DCT9RUKAJ0qVkU0mEeLElW1qg==";tag="web-bot-auth"',
  signature:
    "sig2=:jdq0SqOwHdyHr9+r5jw3iYZH6aNGKijYp/EstF4RQTQdi5N5YYKrD+mCT1HA1nZDsi6nJKuHxUi/5Syp3rLWBA==:",
};
const AT_CREATION = new Date(1735689600_000 + 5_000);
const opts = (over: Partial<VerifyOptions> = {}): VerifyOptions => ({
  origin: ORIGIN,
  resolveKey: resolveTestKey,
  now: AT_CREATION,
  maxLifetimeSeconds: Infinity,
  ...over,
});

// Signs our own request with the test key, as an agent would.
function signed(
  over: {
    components?: string;
    created?: number;
    expires?: number;
    tag?: string;
    url?: string;
  } = {},
) {
  const created = over.created ?? 1735689600;
  const expires = over.expires ?? created + 3600;
  const components = over.components ?? '"@authority" "@method" "signature-agent";key="sig1"';
  const input = `sig1=(${components});created=${created};expires=${expires};keyid="${KEYID}";tag="${over.tag ?? "web-bot-auth"}"`;
  const headers = { "signature-agent": `sig1="${AGENT}"`, "signature-input": input };
  const req = new Request(over.url ?? "https://example.com/api/applications", {
    method: "POST",
    headers,
  });
  const member = parseDictionary(input).get("sig1") as InnerList;
  const base = signatureBase(req, new URL(ORIGIN), member)!;
  const sig = sign(null, Buffer.from(base), TEST_PRIVATE).toString("base64");
  return new Request(req.url, {
    method: "POST",
    headers: { ...headers, signature: `sig1=:${sig}:` },
  });
}

describe("RFC 9421 B.2.6 (Ed25519)", () => {
  it("builds the published signature base and signature", () => {
    const input =
      'sig-b26=("date" "@method" "@path" "@authority" "content-type" "content-length");created=1618884473;keyid="test-key-ed25519"';
    const member = parseDictionary(input).get("sig-b26") as InnerList;
    const base = signatureBase(testRequest(), new URL(ORIGIN), member);
    expect(base).toBe(
      [
        '"date": Tue, 20 Apr 2021 02:07:55 GMT',
        '"@method": POST',
        '"@path": /foo',
        '"@authority": example.com',
        '"content-type": application/json',
        '"content-length": 18',
        '"@signature-params": ("date" "@method" "@path" "@authority" "content-type" "content-length");created=1618884473;keyid="test-key-ed25519"',
      ].join("\n"),
    );
    expect(sign(null, Buffer.from(base!), TEST_PRIVATE).toString("base64")).toBe(
      "wqcAqbmYJ2ji2glfAMaRy4gruYYnx2nEFN2HN6jrnDnQCK1u02Gb04v9EDgwUPiu4A0w6vuQv5lIp5WPpBKRCw==",
    );
  });

  it("uses the RFC 8037 thumbprint as keyid", () => {
    expect(jwkThumbprint(TEST_JWK)).toBe(KEYID);
  });
});

describe("Web Bot Auth draft appendix E.2", () => {
  it("verifies E.2.1 (dictionary Signature-Agent) and E.2.2 (legacy string)", async () => {
    expect(await verifyWebBotAuth(testRequest(E21), opts())).toEqual({
      agent: `${AGENT}/`,
      keyid: KEYID,
      label: "sig2",
    });
    expect((await verifyWebBotAuth(testRequest(E22), opts()))?.agent).toBe(`${AGENT}/`);
  });

  it("gives no signal for a changed signature, authority, agent URL or tag", async () => {
    const bad = (h: Record<string, string>, o: Partial<VerifyOptions> = {}) =>
      verifyWebBotAuth(testRequest({ ...E21, ...h }), opts(o));
    expect(await bad({ signature: E21.signature.replace("CGok", "DGok") })).toBeNull();
    expect(await bad({}, { origin: "https://example.org" })).toBeNull();
    expect(await bad({ "signature-agent": 'sig2="https://other-agent.test"' })).toBeNull();
    expect(
      await bad({ "signature-input": E21["signature-input"].replace("web-bot-auth", "x") }),
    ).toBeNull();
    // A key the directory doesn't hold for that agent URL.
    expect(await bad({}, { resolveKey: async () => null })).toBeNull();
    expect(await bad({ signature: "sig2=garbage" })).toBeNull();
    expect(await verifyWebBotAuth(testRequest(), opts())).toBeNull();
  });
});

describe("freshness and coverage (A4)", () => {
  const live = { now: new Date(1735689600_000 + 60_000), maxLifetimeSeconds: undefined };

  it("accepts a fresh signature covering @authority and signature-agent", async () => {
    expect((await verifyWebBotAuth(signed(), opts(live)))?.agent).toBe(`${AGENT}/`);
  });

  it("refuses expired, future, over-long and incomplete signatures", async () => {
    const t = 1735689600;
    expect(await verifyWebBotAuth(signed({ expires: t + 30 }), opts(live))).toBeNull();
    expect(await verifyWebBotAuth(signed({ created: t + 600 }), opts(live))).toBeNull();
    expect(await verifyWebBotAuth(signed({ expires: t + 2 * 86400 }), opts(live))).toBeNull();
    expect(
      await verifyWebBotAuth(
        signed({ components: '"@method" "signature-agent";key="sig1"' }),
        opts(live),
      ),
    ).toBeNull();
    expect(
      await verifyWebBotAuth(signed({ components: '"@authority" "@method"' }), opts(live)),
    ).toBeNull();
  });
});

describe("key directories (A5)", () => {
  it("only fetches public HTTPS URLs on port 443", () => {
    expect(
      directoryUrlProblem("https://agent.example/.well-known/http-message-signatures-directory"),
    ).toBeNull();
    for (const [url, problem] of [
      ["http://agent.example/keys", "not_https"],
      ["https://user:pw@agent.example/keys", "credentials"],
      ["https://agent.example:8443/keys", "port"],
      ["https://127.0.0.1/keys", "private_address"],
      ["https://[::1]/keys", "private_address"],
      ["https://[::ffff:10.0.0.1]/keys", "private_address"],
      ["https://169.254.169.254/latest", "private_address"],
      ["https://localhost/keys", "not_a_public_name"],
      ["not a url", "not_a_url"],
    ]) {
      expect(directoryUrlProblem(url), url).toBe(problem);
    }
  });

  it("classifies addresses, including IPv4 inside IPv6", () => {
    for (const ip of ["8.8.8.8", "2606:4700::1111", "::ffff:8.8.8.8"]) {
      expect(isPublicAddress(ip), ip).toBe(true);
    }
    for (const ip of [
      "10.1.2.3",
      "172.20.0.1",
      "192.168.1.1",
      "100.64.0.1",
      "0.0.0.0",
      "::",
      "fd00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "64:ff9b::a00:1",
      "not-an-ip",
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });

  it("caches directories, keeps them through a failed refresh, and refuses test keys", async () => {
    let clock = 0;
    let calls = 0;
    let up = true;
    const otherKey: Ed25519Jwk = { kty: "OKP", crv: "Ed25519", x: "A".repeat(43) };
    const resolver = createKeyResolver({
      thumbprint: jwkThumbprint,
      now: () => clock,
      ttlMs: 1000,
      fetch: async () => {
        calls++;
        if (!up) throw new Error("down");
        return [otherKey, TEST_JWK];
      },
    });
    const otherId = jwkThumbprint(otherKey);
    expect(await resolver(AGENT, otherId)).toEqual(otherKey);
    expect(await resolver(AGENT, otherId)).toEqual(otherKey);
    expect(calls).toBe(1);
    // The RFC example key never verifies outside tests (draft 6.8).
    expect(await resolver(AGENT, KEYID)).toBeNull();
    // A failed refresh keeps the cached directory and waits before retrying.
    clock = 2000;
    up = false;
    expect(await resolver(AGENT, otherId)).toEqual(otherKey);
    expect(await resolver(AGENT, otherId)).toEqual(otherKey);
    expect(calls).toBe(2);
  });
});
