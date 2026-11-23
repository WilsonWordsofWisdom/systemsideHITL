// Actor classifier (spec section 6, architecture 4.7, controls A1-A3, FR11-FR14).
// `classifyActor` is a pure function used at sign-in and on every guarded
// request. Detection is a signal: enforcement never depends on it being right,
// because the policy gates humans and unknowns too.
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type { ActorClassName } from "./policy";

const ClassifierFile = z.strictObject({
  version: z.string().min(1),
  thresholds: z.strictObject({ suspect: z.number(), clear: z.number() }),
  window_seconds: z.number().int().min(1),
  weights: z.strictObject({
    webdriver: z.number(),
    untrusted_events: z.number(),
    no_pointer_before_click: z.number(),
    fast_completion: z.number(),
    regular_timing: z.number(),
    missing_browser_headers: z.number(),
    agent_ua_token: z.number(),
    client_context_changed: z.number(),
    no_prior_page_view: z.number(),
  }),
  fast_completion_ms: z.number().int().min(0),
  regular_timing_sd_ms: z.number().min(0),
  regular_timing_min_events: z.number().int().min(2),
  agent_ua_tokens: z.array(z.string().min(1)),
});

export type ClassifierConfig = z.infer<typeof ClassifierFile>;
export type Weight = keyof ClassifierConfig["weights"];

export function parseClassifierConfig(text: string): ClassifierConfig {
  const cfg = ClassifierFile.parse(parse(text));
  if (cfg.thresholds.clear > cfg.thresholds.suspect) {
    throw new Error("classifier thresholds: clear must not exceed suspect");
  }
  return cfg;
}

let cached: ClassifierConfig | undefined;
export function getClassifierConfig(): ClassifierConfig {
  cached ??= parseClassifierConfig(
    readFileSync(path.join(process.cwd(), "policy", "classifier.yaml"), "utf8"),
  );
  return cached;
}

// One behaviour snapshot from public/signals.js (fields are optional because the
// payload is untrusted and validated loosely).
export interface BehaviourSnapshot {
  webdriver?: boolean | null;
  pointerMoves?: number | null;
  clicks?: number | null;
  keys?: number | null;
  untrusted?: number | null;
  msOnPage?: number | null;
  intervalCount?: number | null;
  intervalSdMs?: number | null;
}

export interface ClassifierInput {
  route: "web" | "api" | "mcp";
  // Tier A: protocol-proven identity (MCP token `act` claim, Web Bot Auth). Phases 4-5.
  protocolAgent?: { source: "mcp_token" | "web_bot_auth"; agent: string } | null;
  // Tier B: the sign-in checkbox or an X-Agent header.
  selfDeclared: boolean;
  xAgent: string | null;
  userAgent: string;
  headers: { acceptLanguage: boolean; secFetchSite: string | null };
  // Tier C: snapshots inside the sliding window only (a quiet window is no evidence).
  behaviour: BehaviourSnapshot[];
  noPriorPageView: boolean;
  clientContextChanged: boolean;
  session: {
    signinMethod: "password" | "passkey" | "oauth_mcp";
    loginActorClass: ActorClassName;
    riskState: "clean" | "agent_observed" | "handover_suspected";
  };
}

export interface Classification {
  class: ActorClassName;
  confidence: "high" | "low" | "none";
  // Which rule decided: A, B, score, passkey, sticky or default.
  tier: "A" | "B" | "score" | "passkey" | "sticky" | "default";
  score: number;
  contributions: Partial<Record<Weight, number>>;
  facts: Record<string, unknown>;
  weightsVersion: string;
  // True when agent evidence earlier in the session kept the class up (escalate-only).
  sticky: boolean;
}

// What is stored with the session about its sign-in classification (FR14).
export function loginClassification(c: Classification) {
  return {
    class: c.class,
    tier: c.tier,
    confidence: c.confidence,
    score: c.score,
    contributions: c.contributions,
    weightsVersion: c.weightsVersion,
  };
}

const AGENT_CLASSES: ReadonlySet<ActorClassName> = new Set(["declared_agent", "suspected_agent"]);

function scoreBehaviour(input: ClassifierInput, cfg: ClassifierConfig) {
  const hits: Partial<Record<Weight, boolean>> = {};
  for (const s of input.behaviour) {
    if (s.webdriver === true) hits.webdriver = true;
    if ((s.untrusted ?? 0) > 0) hits.untrusted_events = true;
    if ((s.clicks ?? 0) > 0 && (s.pointerMoves ?? 0) === 0) hits.no_pointer_before_click = true;
    const interacted = (s.clicks ?? 0) + (s.keys ?? 0) > 0;
    if (interacted && s.msOnPage != null && s.msOnPage < cfg.fast_completion_ms) {
      hits.fast_completion = true;
    }
    if (
      (s.intervalCount ?? 0) >= cfg.regular_timing_min_events &&
      s.intervalSdMs != null &&
      s.intervalSdMs < cfg.regular_timing_sd_ms
    ) {
      hits.regular_timing = true;
    }
  }
  if (!input.headers.acceptLanguage || !input.headers.secFetchSite) {
    hits.missing_browser_headers = true;
  }
  const ua = input.userAgent.toLowerCase();
  const uaToken = cfg.agent_ua_tokens.find((t) => ua.includes(t.toLowerCase()));
  if (uaToken) hits.agent_ua_token = true;
  if (input.clientContextChanged) hits.client_context_changed = true;
  if (input.noPriorPageView) hits.no_prior_page_view = true;

  const contributions: Partial<Record<Weight, number>> = {};
  let score = 0;
  for (const key of Object.keys(hits) as Weight[]) {
    contributions[key] = cfg.weights[key];
    score += cfg.weights[key];
  }
  return { score: Math.min(score, 100), contributions, uaToken: uaToken ?? null };
}

export function classifyActor(input: ClassifierInput, cfg: ClassifierConfig): Classification {
  const { score, contributions, uaToken } = scoreBehaviour(input, cfg);
  const facts = {
    route: input.route,
    protocolAgent: input.protocolAgent ?? null,
    selfDeclared: input.selfDeclared,
    xAgent: input.xAgent,
    uaToken,
    snapshotsInWindow: input.behaviour.length,
    noPriorPageView: input.noPriorPageView,
    clientContextChanged: input.clientContextChanged,
    signinMethod: input.session.signinMethod,
    loginActorClass: input.session.loginActorClass,
    riskState: input.session.riskState,
  };
  const base = { score, contributions, facts, weightsVersion: cfg.version };

  // Precedence, first match wins (architecture 4.7).
  if (input.protocolAgent) {
    return { ...base, class: "declared_agent", confidence: "high", tier: "A", sticky: false };
  }
  if (input.selfDeclared || input.xAgent) {
    return { ...base, class: "declared_agent", confidence: "low", tier: "B", sticky: false };
  }
  if (score >= cfg.thresholds.suspect) {
    return { ...base, class: "suspected_agent", confidence: "low", tier: "score", sticky: false };
  }

  // Escalate-only: agent evidence earlier in the session (at sign-in, or a risk
  // state above clean) keeps the class up; a quiet request never lowers it (A2).
  const login = input.session.loginActorClass;
  if (AGENT_CLASSES.has(login)) {
    return { ...base, class: login, confidence: "low", tier: "sticky", sticky: true };
  }
  if (input.session.riskState !== "clean") {
    return { ...base, class: "suspected_agent", confidence: "low", tier: "sticky", sticky: true };
  }

  if (input.session.signinMethod === "passkey" && score < cfg.thresholds.clear) {
    return { ...base, class: "human", confidence: "low", tier: "passkey", sticky: false };
  }
  // No evidence is not evidence of a human.
  return { ...base, class: "unknown", confidence: "none", tier: "default", sticky: false };
}
