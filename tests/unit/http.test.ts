import { describe, expect, it } from "vitest";
import { ipHash, isSameOrigin, readBody, wantsHtml } from "@/lib/http";

const ORIGIN = "https://hitltest.vercel.app";
const req = (method: string, headers: Record<string, string> = {}, body?: string) =>
  new Request(`${ORIGIN}/api/x`, { method, headers, body });

describe("isSameOrigin (control S2)", () => {
  it("allows reads regardless of origin", () => {
    expect(isSameOrigin(req("GET", { origin: "https://evil.example" }), ORIGIN)).toBe(true);
  });
  it("checks Origin on writes", () => {
    expect(isSameOrigin(req("POST", { origin: ORIGIN }), ORIGIN)).toBe(true);
    expect(isSameOrigin(req("POST", { origin: "https://evil.example" }), ORIGIN)).toBe(false);
    expect(
      isSameOrigin(req("POST", { origin: "https://hitltest.vercel.app.evil.example" }), ORIGIN),
    ).toBe(false);
  });
  it("falls back to Referer, and rejects writes with neither", () => {
    expect(isSameOrigin(req("POST", { referer: `${ORIGIN}/login` }), ORIGIN)).toBe(true);
    expect(isSameOrigin(req("POST", { referer: "https://evil.example/x" }), ORIGIN)).toBe(false);
    expect(isSameOrigin(req("POST"), ORIGIN)).toBe(false);
  });
});

describe("request bodies", () => {
  it("reads form and JSON bodies", async () => {
    const form = req(
      "POST",
      { "content-type": "application/x-www-form-urlencoded" },
      "email=a%40b.test&x=1",
    );
    expect(wantsHtml(form)).toBe(true);
    expect(await readBody(form)).toEqual({ email: "a@b.test", x: "1" });
    const json = req(
      "POST",
      { "content-type": "application/json" },
      JSON.stringify({ email: "a@b.test", n: 2 }),
    );
    expect(wantsHtml(json)).toBe(false);
    expect(await readBody(json)).toEqual({ email: "a@b.test", n: "2" });
  });
  it("rejects oversized bodies", async () => {
    const big = req(
      "POST",
      { "content-type": "application/json" },
      JSON.stringify({ a: "x".repeat(20000) }),
    );
    await expect(readBody(big)).rejects.toThrow();
  });
});

describe("ipHash (control D4)", () => {
  it("is stable, keyed and never contains the address", () => {
    const a = ipHash("203.0.113.7", "k".repeat(32));
    expect(a).toBe(ipHash("203.0.113.7", "k".repeat(32)));
    expect(a).not.toBe(ipHash("203.0.113.7", "j".repeat(32)));
    expect(a).not.toContain("203.0.113.7");
  });
});
