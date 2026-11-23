// Classifier precedence, escalate-only and scoring (architecture 4.7, controls A1-A2, FR11-FR14).
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyActor,
  getClassifierConfig,
  parseClassifierConfig,
  type ClassifierInput,
} from "@/lib/hitl/classifier";

const cfg = getClassifierConfig();
const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

// A quiet, browser-like request on a password session: no evidence either way.
function input(over: Partial<ClassifierInput> = {}): ClassifierInput {
  return {
    route: "web",
    protocolAgent: null,
    selfDeclared: false,
    xAgent: null,
    userAgent: CHROME_UA,
    headers: { acceptLanguage: true, secFetchSite: "same-origin" },
    behaviour: [],
    noPriorPageView: false,
    clientContextChanged: false,
    session: { signinMethod: "password", loginActorClass: "unknown", riskState: "clean" },
    ...over,
  };
}
const humanSnapshot = {
  webdriver: false,
  pointerMoves: 40,
  clicks: 2,
  keys: 12,
  untrusted: 0,
  msOnPage: 9000,
  intervalCount: 14,
  intervalSdMs: 180,
};

describe("precedence (first match wins)", () => {
  it("1. protocol-proven identity is declared_agent with high confidence", () => {
    const c = classifyActor(
      input({ protocolAgent: { source: "mcp_token", agent: "client-1" } }),
      cfg,
    );
    expect(c).toMatchObject({ class: "declared_agent", confidence: "high", tier: "A" });
  });

  it("2. self-declaration (checkbox or X-Agent) is declared_agent with low confidence", () => {
    expect(classifyActor(input({ selfDeclared: true }), cfg)).toMatchObject({
      class: "declared_agent",
      confidence: "low",
      tier: "B",
    });
    expect(classifyActor(input({ xAgent: "my-agent" }), cfg)).toMatchObject({
      class: "declared_agent",
      tier: "B",
    });
  });

  it("tier A wins over a high score and over self-declaration", () => {
    const c = classifyActor(
      input({
        protocolAgent: { source: "web_bot_auth", agent: "op" },
        selfDeclared: true,
        behaviour: [{ webdriver: true }],
      }),
      cfg,
    );
    expect(c.tier).toBe("A");
  });

  it("3. a score at or above the threshold is suspected_agent", () => {
    const c = classifyActor(input({ behaviour: [{ webdriver: true }] }), cfg);
    expect(c).toMatchObject({ class: "suspected_agent", tier: "score", score: 50 });
  });

  it("4. a passkey session with a low score and no agent evidence is human", () => {
    const c = classifyActor(
      input({
        behaviour: [humanSnapshot],
        session: { signinMethod: "passkey", loginActorClass: "human", riskState: "clean" },
      }),
      cfg,
    );
    expect(c).toMatchObject({ class: "human", tier: "passkey" });
  });

  it("a passkey session with a score between the thresholds is unknown, not human", () => {
    const c = classifyActor(
      input({
        userAgent: "curl/8.4",
        session: { signinMethod: "passkey", loginActorClass: "unknown", riskState: "clean" },
      }),
      cfg,
    );
    expect(c.score).toBeGreaterThanOrEqual(cfg.thresholds.clear);
    expect(c.score).toBeLessThan(cfg.thresholds.suspect);
    expect(c.class).toBe("unknown");
  });

  it("5. no evidence is not evidence of a human", () => {
    expect(classifyActor(input(), cfg)).toMatchObject({
      class: "unknown",
      tier: "default",
      score: 0,
    });
  });
});

describe("escalate-only (A2)", () => {
  it("agent evidence at sign-in keeps the session an agent on quiet requests", () => {
    const c = classifyActor(
      input({
        session: {
          signinMethod: "password",
          loginActorClass: "suspected_agent",
          riskState: "clean",
        },
      }),
      cfg,
    );
    expect(c).toMatchObject({ class: "suspected_agent", tier: "sticky", sticky: true });
    const d = classifyActor(
      input({
        session: {
          signinMethod: "password",
          loginActorClass: "declared_agent",
          riskState: "clean",
        },
      }),
      cfg,
    );
    expect(d.class).toBe("declared_agent");
  });

  it("a risk state above clean counts as agent evidence, even on a passkey session", () => {
    for (const riskState of ["agent_observed", "handover_suspected"] as const) {
      const c = classifyActor(
        input({
          behaviour: [humanSnapshot],
          session: { signinMethod: "passkey", loginActorClass: "human", riskState },
        }),
        cfg,
      );
      expect(c.class).toBe("suspected_agent");
      expect(c.sticky).toBe(true);
    }
  });

  it("a human-leaning login followed by agent-like requests is reclassified (T10)", () => {
    const c = classifyActor(
      input({
        behaviour: [{ webdriver: true, untrusted: 3 }],
        session: { signinMethod: "passkey", loginActorClass: "human", riskState: "clean" },
      }),
      cfg,
    );
    expect(c.class).toBe("suspected_agent");
  });
});

describe("scoring", () => {
  const cases: [string, Partial<ClassifierInput>, keyof typeof cfg.weights][] = [
    ["webdriver", { behaviour: [{ webdriver: true }] }, "webdriver"],
    ["untrusted events", { behaviour: [{ untrusted: 2 }] }, "untrusted_events"],
    [
      "clicks without pointer movement",
      { behaviour: [{ clicks: 3, pointerMoves: 0, msOnPage: 9000 }] },
      "no_pointer_before_click",
    ],
    [
      "fast completion",
      { behaviour: [{ keys: 10, pointerMoves: 5, msOnPage: 900 }] },
      "fast_completion",
    ],
    [
      "perfectly regular timing",
      { behaviour: [{ intervalCount: 10, intervalSdMs: 1 }] },
      "regular_timing",
    ],
    [
      "missing browser headers",
      { headers: { acceptLanguage: false, secFetchSite: null } },
      "missing_browser_headers",
    ],
    ["agent UA token", { userAgent: "python-requests/2.32" }, "agent_ua_token"],
    ["client context changed", { clientContextChanged: true }, "client_context_changed"],
    ["no prior page view", { noPriorPageView: true }, "no_prior_page_view"],
  ];
  it.each(cases)("%s adds its weight", (_name, over, weight) => {
    const c = classifyActor(input(over), cfg);
    expect(c.contributions).toEqual({ [weight]: cfg.weights[weight] });
    expect(c.score).toBe(cfg.weights[weight]);
  });

  it("a human-like snapshot adds nothing", () => {
    expect(classifyActor(input({ behaviour: [humanSnapshot] }), cfg).score).toBe(0);
  });

  it("caps the score at 100 and records the weights version and facts (FR14)", () => {
    const c = classifyActor(
      input({
        userAgent: "HeadlessChrome",
        behaviour: [{ webdriver: true, untrusted: 1 }],
        noPriorPageView: true,
      }),
      cfg,
    );
    expect(c.score).toBe(100);
    expect(c.weightsVersion).toBe(cfg.version);
    expect(c.facts).toMatchObject({ uaToken: "HeadlessChrome", snapshotsInWindow: 1 });
  });

  it("a quiet window (no snapshots) is no evidence (FR13)", () => {
    expect(classifyActor(input({ behaviour: [] }), cfg).contributions).toEqual({});
  });
});

describe("classifier config", () => {
  const text = readFileSync(path.join(process.cwd(), "policy", "classifier.yaml"), "utf8");
  it("parses the shipped file", () => {
    expect(parseClassifierConfig(text).thresholds).toEqual({ suspect: 50, clear: 20 });
  });
  it("rejects a missing weight or inverted thresholds", () => {
    expect(() => parseClassifierConfig(text.replace(/\n {2}webdriver: 50/, ""))).toThrow();
    expect(() => parseClassifierConfig(text.replace("clear: 20", "clear: 70"))).toThrow();
  });
});
