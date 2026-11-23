// Console admin tokens, run IDs and export formatting (FR39, FR40, controls L2, L4).
import { describe, expect, it } from "vitest";
import {
  ADMIN_TTL_MS,
  adminCsrf,
  adminSecretMatches,
  getAdminSecret,
  makeAdminToken,
  verifyAdminToken,
} from "@/lib/console/admin";
import { exportRow, signalsSummary, toCsv, type RequestRow } from "@/lib/console/queries";
import { runIdFromRequest, validRunId } from "@/lib/console/run";

const KEY = "k".repeat(32);
const SECRET = "admin-secret-0123456789";
const t0 = new Date("2026-12-01T09:00:00Z");

describe("admin secret and token (L2)", () => {
  it("needs ADMIN_SECRET of at least 16 characters", () => {
    expect(getAdminSecret({})).toBeNull();
    expect(getAdminSecret({ ADMIN_SECRET: "short" })).toBeNull();
    expect(getAdminSecret({ ADMIN_SECRET: SECRET })).toBe(SECRET);
  });

  it("matches only the exact secret", () => {
    expect(adminSecretMatches(SECRET, SECRET)).toBe(true);
    expect(adminSecretMatches(`${SECRET} `, SECRET)).toBe(false);
    expect(adminSecretMatches("", SECRET)).toBe(false);
  });

  it("accepts its own token until it expires", () => {
    const token = makeAdminToken(KEY, SECRET, t0);
    expect(verifyAdminToken(token, KEY, SECRET, t0)).toBe(true);
    expect(verifyAdminToken(token, KEY, SECRET, new Date(t0.getTime() + ADMIN_TTL_MS))).toBe(false);
  });

  it("rejects a forged, altered or re-dated token, and any token after the secret changes", () => {
    const token = makeAdminToken(KEY, SECRET, t0);
    const [expiry, mac] = token.split(".");
    expect(verifyAdminToken(`${Number(expiry) + 1000}.${mac}`, KEY, SECRET, t0)).toBe(false);
    expect(verifyAdminToken(`${expiry}.x${mac.slice(1)}`, KEY, SECRET, t0)).toBe(false);
    expect(verifyAdminToken("garbage", KEY, SECRET, t0)).toBe(false);
    expect(verifyAdminToken(undefined, KEY, SECRET, t0)).toBe(false);
    expect(verifyAdminToken(token, KEY, "another-admin-secret-123", t0)).toBe(false);
    expect(verifyAdminToken(token, "j".repeat(32), SECRET, t0)).toBe(false);
  });

  it("binds the console CSRF token to the admin cookie", () => {
    const a = makeAdminToken(KEY, SECRET, t0);
    const b = makeAdminToken(KEY, SECRET, new Date(t0.getTime() + 1));
    expect(adminCsrf(KEY, a)).not.toBe(adminCsrf(KEY, b));
  });
});

describe("run IDs (FR40)", () => {
  it("accepts short identifiers only", () => {
    expect(validRunId("r42")).toBe("r42");
    expect(validRunId("run_2026-12-01")).toBe("run_2026-12-01");
    for (const bad of ["", "a b", "<script>", "x".repeat(41), "r42;drop"]) {
      expect(validRunId(bad)).toBeNull();
    }
  });

  it("reads the run cookie from a request", () => {
    const req = new Request("http://x/", { headers: { cookie: "a=1; dg_run=r42; b=2" } });
    expect(runIdFromRequest(req)).toBe("r42");
    const bad = new Request("http://x/", { headers: { cookie: "dg_run=%3Cscript%3E" } });
    expect(runIdFromRequest(bad)).toBeNull();
  });
});

describe("table summary and export (L4)", () => {
  const row = {
    id: "1",
    ts: t0,
    route: "api",
    method: "POST",
    pathOrTool: "/api/applications/x/submit",
    userId: "u",
    sessionId: "abc",
    runId: "r42",
    actorClass: "suspected_agent",
    actorSignals: {
      tier: "score",
      score: 65,
      contributions: { no_prior_page_view: 10, client_context_changed: 30, agent_ua_token: 25 },
      riskChange: { to: "handover_suspected" },
    },
    policyDecision: "gate",
    ticketId: "hitl_x",
    outcome: "gated",
    reason: "ticket_created",
    latencyMs: 12,
    userAgent: '=HYPERLINK("https://evil")',
    ipHash: "hashed-ip",
  } as unknown as RequestRow;

  it("summarises the signals in one line", () => {
    expect(signalsSummary(row.actorSignals)).toBe(
      "no page view, ctx changed, agent UA · score 65 · risk → handover_suspected",
    );
    expect(signalsSummary({ facts: { classifierError: true } })).toBe("classifier error");
    expect(
      signalsSummary({
        tier: "A",
        facts: { protocolAgent: { source: "web_bot_auth", agent: "https://a.example/" } },
      }),
    ).toBe("Web Bot Auth");
    // MCP rows show the client's revision and URL elicitation support (M6).
    expect(
      signalsSummary({
        tier: "A",
        mcp: {
          era: "modern",
          protocolVersion: "2026-07-28",
          capabilities: { elicitation: { url: {} } },
        },
      }),
    ).toBe("protocol identity · MCP 2026-07-28 · URL elicitation");
    expect(
      signalsSummary({
        tier: "A",
        mcp: { era: "legacy", protocolVersion: null, capabilities: {} },
      }),
    ).toBe("protocol identity · MCP legacy · no URL elicitation");
  });

  it("exports hashed IPs and quotes every CSV cell, neutralising formulas", () => {
    const exported = exportRow(row);
    expect(exported.ip_hash).toBe("hashed-ip");
    expect(Object.keys(exported)).not.toContain("ip");
    const csv = toCsv([exported]);
    const [header, line] = csv.split("\r\n");
    expect(header.split(",")).toContain("ip_hash");
    expect(line).toContain(`"'=HYPERLINK(""https://evil"")"`);
    expect(line).toContain('"r42"');
  });
});
