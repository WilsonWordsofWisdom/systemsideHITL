import { describe, expect, it } from "vitest";
import { ConfigError, MAX_OBSERVE_MS, effectiveHitlMode, loadConfig } from "@/lib/config";

const base = { APP_ORIGIN: "https://hitltest.vercel.app", RP_ID: "hitltest.vercel.app" };

describe("loadConfig", () => {
  it("accepts the production origin and RP ID with defaults", () => {
    expect(loadConfig(base)).toEqual({
      appOrigin: "https://hitltest.vercel.app",
      rpId: "hitltest.vercel.app",
      ticketTtlSeconds: 600,
      hitlMode: "enforce",
      observeUntil: null,
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
    const until = "2026-12-01T18:00:00Z";
    expect(() => loadConfig({ ...base, HITL_MODE: "observe", HITL_OBSERVE_UNTIL: until })).toThrow(
      /HITL_ALLOW_OBSERVE/,
    );
  });

  describe("observe mode end time (gap H6)", () => {
    const now = new Date("2026-12-01T09:00:00Z");
    const observe = { ...base, HITL_MODE: "observe", HITL_ALLOW_OBSERVE: "true" };

    it.each([
      ["missing", undefined],
      ["not a date", "tomorrow"],
      ["without a time zone", "2026-12-01T18:00:00"],
      ["a date only", "2026-12-01"],
    ])("refuses an end time that is %s", (_label, value) => {
      expect(() => loadConfig({ ...observe, HITL_OBSERVE_UNTIL: value }, now)).toThrow(
        /HITL_OBSERVE_UNTIL/,
      );
    });

    it("refuses an end time more than 24 hours ahead", () => {
      const late = new Date(now.getTime() + MAX_OBSERVE_MS + 60_000).toISOString();
      expect(() => loadConfig({ ...observe, HITL_OBSERVE_UNTIL: late }, now)).toThrow(
        /at most 24 hours/,
      );
    });

    it("observes until the end time, then enforces by itself", () => {
      const cfg = loadConfig({ ...observe, HITL_OBSERVE_UNTIL: "2026-12-01T18:00:00+00:00" }, now);
      expect(cfg.hitlMode).toBe("observe");
      expect(effectiveHitlMode(cfg, now)).toBe("observe");
      expect(effectiveHitlMode(cfg, new Date("2026-12-01T17:59:59Z"))).toBe("observe");
      expect(effectiveHitlMode(cfg, new Date("2026-12-01T18:00:00Z"))).toBe("enforce");
    });

    it("accepts an end time already past, and enforces", () => {
      const cfg = loadConfig({ ...observe, HITL_OBSERVE_UNTIL: "2026-11-30T09:00:00Z" }, now);
      expect(effectiveHitlMode(cfg, now)).toBe("enforce");
    });

    it("ignores an end time when the mode is enforce", () => {
      const cfg = loadConfig({ ...base, HITL_OBSERVE_UNTIL: "2026-12-01T18:00:00Z" }, now);
      expect(effectiveHitlMode(cfg, now)).toBe("enforce");
    });
  });
});
