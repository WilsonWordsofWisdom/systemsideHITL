// hitlGuard: the single decision and enforcement point (spec section 8, controls
// C1-C4, S10, L1). Every mutating journey route and, in Phase 4, every MCP tool
// calls it before the action runs. Every call writes a request_log row.
import type { SessionRow } from "../auth/session";
import type { AppDb } from "../db/types";
import { clientIp, ipHash } from "../http";
import { logEvent } from "../log";
import { lockedUntil, recordFailure, type LimitRule } from "../ratelimit";
import {
  classifyActor,
  getClassifierConfig,
  type Classification,
  type ClassifierConfig,
} from "./classifier";
import { payloadHash, stripVolatile } from "./hash";
import { requestClassifierInput } from "./inputs";
import { getPolicy, type Decision, type Policy } from "./policy";
import { buildSnapshot } from "./snapshot";
import {
  getTicket,
  redeemTicket,
  requestTicket,
  stateFailure,
  type RedeemFailure,
  type Ticket,
} from "./tickets";

// Ticket creation limits (control T9, FR23).
export const TICKET_USER_LIMIT: LimitRule = { max: 20, windowSec: 60, lockSec: 60 };
export const TICKET_IP_LIMIT: LimitRule = { max: 60, windowSec: 60, lockSec: 60 };

export type Outcome = "executed" | "error";

export type GuardResult =
  | {
      kind: "ok";
      actor: Classification;
      decision: Decision;
      finish: (o: Outcome, reason?: string) => Promise<void>;
    }
  | { kind: "denied"; actor: Classification; reason: "policy" | "rate_limited" }
  | { kind: "gated"; actor: Classification; ticket: Ticket; reused: boolean }
  | { kind: "ticket_invalid"; actor: Classification; ticketId: string; reason: RedeemFailure };

export interface GuardInput {
  db: AppDb;
  request: Request;
  route: "web" | "api";
  userId: string;
  session: SessionRow;
  action: string;
  resourceId: string | null;
  body: Record<string, string>;
  secret: string;
  mode: "enforce" | "observe";
  ttlSeconds: number;
  now?: Date;
}

export interface GuardDeps {
  policy: () => Policy;
  classifierConfig: () => ClassifierConfig;
  classify: typeof classifyActor;
}

const defaultDeps: GuardDeps = {
  policy: getPolicy,
  classifierConfig: getClassifierConfig,
  classify: classifyActor,
};

// The ticket ID comes from the X-HITL-Ticket header, or a form field for the
// web Continue button (forms can't set headers).
export function ticketIdFrom(request: Request, body: Record<string, string>) {
  return request.headers.get("x-hitl-ticket")?.trim() || body.hitl_ticket?.trim() || null;
}

const FAILED_CLASSIFICATION = (version: string): Classification => ({
  class: "unknown",
  confidence: "none",
  tier: "default",
  score: 0,
  contributions: {},
  facts: { classifierError: true },
  weightsVersion: version,
  sticky: false,
});

export async function hitlGuard(
  input: GuardInput,
  deps: GuardDeps = defaultDeps,
): Promise<GuardResult> {
  const started = Date.now();
  const now = input.now ?? new Date();
  const { db, request, session } = input;
  const policy = deps.policy();
  const ip = ipHash(clientIp(request), input.secret);

  // Classify; any failure fails closed (control C3).
  let actor: Classification;
  let classifierFailed = false;
  try {
    const cfg = deps.classifierConfig();
    actor = deps.classify(
      await requestClassifierInput({
        db,
        request,
        session,
        route: input.route,
        cfg,
        secret: input.secret,
        now,
      }),
      cfg,
    );
  } catch {
    classifierFailed = true;
    actor = FAILED_CLASSIFICATION("unavailable");
  }

  let decision = policy.decide(input.action, actor.class);
  if (classifierFailed && decision !== "deny") {
    decision = policy.isCritical(input.action) ? "deny" : "gate";
  }

  const log = (row: {
    outcome: "executed" | "blocked" | "gated" | "error";
    reason?: string | null;
    ticketId?: string | null;
  }) =>
    logEvent(db, {
      route: input.route,
      method: request.method,
      pathOrTool: new URL(request.url).pathname,
      userId: input.userId,
      sessionId: session.id,
      actorClass: actor.class,
      actorSignals: {
        tier: actor.tier,
        confidence: actor.confidence,
        score: actor.score,
        contributions: actor.contributions,
        facts: actor.facts,
        weightsVersion: actor.weightsVersion,
        sticky: actor.sticky,
        action: input.action,
        mode: input.mode,
      },
      policyDecision: decision,
      ticketId: row.ticketId ?? null,
      outcome: row.outcome,
      reason: row.reason ?? null,
      latencyMs: Date.now() - started,
      userAgent: (request.headers.get("user-agent") ?? "").slice(0, 300),
      ipHash: ip,
    });

  const ok = (reason: string | null, ticketId: string | null = null): GuardResult => ({
    kind: "ok",
    actor,
    decision,
    finish: (o, r) => log({ outcome: o, reason: r ?? reason, ticketId }),
  });

  // Observe mode computes and logs the decision, then lets the action run (T12).
  if (input.mode === "observe") return ok(decision === "allow" ? null : `observe:${decision}`);
  if (decision === "allow") return ok(null);
  if (decision === "deny") {
    await log({ outcome: "blocked", reason: classifierFailed ? "classifier_error" : "policy" });
    return { kind: "denied", actor, reason: "policy" };
  }

  // Gate. A supplied ticket that can't be redeemed whatever the payload (unknown,
  // another session's, pending, used, declined, expired) is reported first.
  const ticketId = ticketIdFrom(request, input.body);
  if (ticketId) {
    const existing = await getTicket(db, ticketId, now);
    const early = existing
      ? stateFailure(existing, { userId: input.userId, sessionId: session.id }, now)
      : "not_found";
    if (early) {
      await log({ outcome: "blocked", reason: `ticket:${early}`, ticketId });
      return { kind: "ticket_invalid", actor, ticketId, reason: early };
    }
  }

  // Preconditions and the resource snapshot come next, so no ticket is created
  // for an action that could not run (throws JourneyError).
  let built: Awaited<ReturnType<typeof buildSnapshot>>;
  try {
    built = await buildSnapshot(db, input.action, input.userId, input.resourceId, input.body);
  } catch (err) {
    await log({
      outcome: "error",
      reason: `precondition:${(err as { code?: string }).code ?? "error"}`,
    });
    throw err;
  }
  const { snapshot, preview } = built;
  const hash = payloadHash({
    action: input.action,
    resourceId: input.resourceId,
    body: input.body,
    snapshot,
  });

  if (ticketId) {
    const redeemed = await redeemTicket(
      db,
      ticketId,
      {
        userId: input.userId,
        action: input.action,
        resourceId: input.resourceId,
        payloadHash: hash,
        sessionId: session.id,
      },
      now,
    );
    if (redeemed.ok) return ok("ticket_consumed", ticketId);
    await log({ outcome: "blocked", reason: `ticket:${redeemed.reason}`, ticketId });
    return { kind: "ticket_invalid", actor, ticketId, reason: redeemed.reason };
  }

  const userKey = `ticket:user:${input.userId}`;
  const ipKey = `ticket:ip:${ip}`;
  if ((await lockedUntil(db, userKey, now)) || (await lockedUntil(db, ipKey, now))) {
    await log({ outcome: "blocked", reason: "rate_limited" });
    return { kind: "denied", actor, reason: "rate_limited" };
  }

  const { ticket, reused, superseded } = await requestTicket(
    db,
    {
      userId: input.userId,
      action: input.action,
      resourceId: input.resourceId,
      payloadHash: hash,
      // The request fields the hash covers, so the web Continue button can resubmit
      // exactly what was approved (FR27).
      preview: { ...preview, request: stripVolatile(input.action, input.body) },
      actor: { class: actor.class, tier: actor.tier, score: actor.score, facts: actor.facts },
      sessionId: session.id,
      ttlSeconds: input.ttlSeconds,
    },
    now,
  );
  if (!reused) {
    await recordFailure(db, userKey, TICKET_USER_LIMIT, now);
    await recordFailure(db, ipKey, TICKET_IP_LIMIT, now);
  }
  await log({
    outcome: "gated",
    reason: reused
      ? "ticket_reused"
      : superseded.length
        ? `superseded:${superseded.join(",")}`
        : "ticket_created",
    ticketId: ticket.id,
  });
  return { kind: "gated", actor, ticket, reused };
}
