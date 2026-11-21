import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "@/lib/config";

const base = { APP_ORIGIN: "https://hitltest.vercel.app", RP_ID: "hitltest.vercel.app" };

describe("loadConfig", () => {
  it("accepts the production origin and RP ID with defaults", () => {
    expect(loadConfig(base)).toEqual({
      appOrigin: "https://hitltest.vercel.app",
      rpId: "hitltest.vercel.app",
      ticketTtlSeconds: 600,
      hitlMode: "enforce",
    });
  });

  it("allows http only for localhost", () => {
    expect(loadConfig({ APP_ORIGIN: "http://localhost:3000", RP_ID: "localhost" }).appOrigin).toBe(
      "http://localhost:3000",
    );
    expect(() =>
      loadConfig({ APP_ORIGIN: "http://hitltest.vercel.app", RP_ID: "hitltest.vercel.app" }),
    ).toThrow(ConfigError);
  });

  it.each([
    ["missing origin", { RP_ID: "hitltest.vercel.app" }],
    ["origin with a path", { ...base, APP_ORIGIN: "https://hitltest.vercel.app/app" }],
    ["unrelated RP ID", { ...base, RP_ID: "example.com" }],
    ["look-alike RP ID suffix", { ...base, RP_ID: "test.vercel.app" }],
    ["TTL above 10 minutes", { ...base, TICKET_TTL_SECONDS: "601" }],
    ["non-integer TTL", { ...base, TICKET_TTL_SECONDS: "60.5" }],
    ["unknown HITL mode", { ...base, HITL_MODE: "off" }],
  ])("rejects %s", (_label, env) => {
    expect(() => loadConfig(env)).toThrow(ConfigError);
  });

  it("accepts an RP ID that is a parent domain of the origin host", () => {
    expect(
      loadConfig({ APP_ORIGIN: "https://permits.example.com", RP_ID: "example.com" }).rpId,
    ).toBe("example.com");
  });

  it("refuses observe mode without the explicit allow switch (control C6)", () => {
    expect(() => loadConfig({ ...base, HITL_MODE: "observe" })).toThrow(/HITL_ALLOW_OBSERVE/);
    expect(loadConfig({ ...base, HITL_MODE: "observe", HITL_ALLOW_OBSERVE: "true" }).hitlMode).toBe(
      "observe",
    );
  });
});
