// hitlGuard: the single decision and enforcement point (spec section 8, controls
// C1-C4, S10, L1). Every mutating journey route and, in Phase 4, every MCP tool
// calls it before the action runs. Every call writes a request_log row.
import { escalateRisk, nextRiskState, type SessionRow } from "../auth/session";
import type { AppDb } from "../db/types";
import { runIdFromRequest } from "../console/run";
import { clientIp, ipHash } from "../http";
import { logEvent, ticketActionOutcome } from "../log";
import type { McpClientInfo } from "../mcp/request";
import { revisionFor, type PoppyApproval } from "../poppy/operations";
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
import { webBotAuthAgent } from "../webBotAuth";
import {
  getTicket,
  redeemTicket,
  requestTicket,
  stateFailure,
  type RedeemFailure,
  type Ticket,
} from "./tickets";

// Tiers that are evidence from the request itself, as opposed to a class carried
// over from earlier in the session (escalate-only, architecture 4.7).
const FRESH_EVIDENCE_TIERS: ReadonlySet<string> = new Set(["A", "B", "score"]);

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
  | { kind: "ticket_invalid"; actor: Classification; ticketId: string; reason: RedeemFailure }
  // Poppy Operations (FR44): an approval for a revision that still needs the
  // account holder's passkey, and a resend for an operation already performed.
  | { kind: "approval_declined"; actor: Classification; ticket: Ticket }
  | {
      kind: "already_performed";
      actor: Classification;
      ticket: Ticket;
      status: "performed" | "performing" | "failed";
    };

export interface GuardInput {
  db: AppDb;
  request: Request;
  route: "web" | "api" | "mcp";
  userId: string;
  session: SessionRow;
  // MCP: the OAuth client acting for the user. It is tier A evidence (the token
  // names the client), binds tickets to the client, and the tool name and the
  // client's declared revision and capabilities are logged (control M6).
  mcp?: {
    clientId: string;
    tool: string;
    client?: McpClientInfo;
    // A verified Poppy Session on the request (FR46): tier A as a Poppy agent.
    poppySession?: { sid: string; sub: string } | null;
  };
  // A Poppy Operations approval (Poppy-Approval header or MCP _meta), passed only
  // when POPPY=on and the request declares the extension (FR43, FR44).
  poppyApproval?: PoppyApproval | null;
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
  // Web Bot Auth: the agent a valid request signature names (FR37, A7).
  webBotAuth: typeof webBotAuthAgent;
}

const defaultDeps: GuardDeps = {
  policy: getPolicy,
  classifierConfig: getClassifierConfig,
  classify: classifyActor,
  webBotAuth: webBotAuthAgent,
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

  // Classify, then raise the session's risk state on fresh evidence (architecture
  // 4.9 layers 2-3). Any failure fails closed (control C3).
  let actor: Classification;
  let classifierFailed = false;
  let risk: { from: string; to: string; trigger: string } | null = null;
  try {
    const cfg = deps.classifierConfig();
    // Tier A: the MCP token names the client; on the web, a valid Web Bot Auth
    // signature marks this one request, even on a human's cookie (A7).
    const protocolAgent = input.mcp
      ? {
          source: input.mcp.poppySession ? ("poppy_session" as const) : ("mcp_token" as const),
          agent: input.mcp.clientId,
        }
      : session.signinMethod === "poppy_join"
        ? // A browser that joined a Poppy agent's session (FR47): declared handover.
          {
            source: "poppy_join" as const,
            agent: String(
              (session.loginSignals as { poppy?: { clientId?: unknown } }).poppy?.clientId ??
                "poppy",
            ),
          }
        : await deps.webBotAuth(request);
    const classifierInput = await requestClassifierInput({
      db,
      request,
      session,
      route: input.route,
      cfg,
      secret: input.secret,
      now,
      protocolAgent,
    });
    actor = deps.classify(classifierInput, cfg);
    const next = nextRiskState(session.riskState, {
      agentEvidence: FRESH_EVIDENCE_TIERS.has(actor.tier),
      humanLeaningLogin: session.loginActorClass === "human",
      contextChanged: classifierInput.clientContextChanged,
    });
    if (next) {
      const changed = await escalateRisk(
        db,
        session.id,
        next.to,
        next.trigger,
        {
          class: actor.class,
          tier: actor.tier,
          score: actor.score,
          contributions: actor.contributions,
        },
        now,
      );
      if (changed) {
        risk = { ...changed, trigger: next.trigger };
        // The escalation counts for this request too, not only the next one.
        actor = deps.classify(
          { ...classifierInput, session: { ...classifierInput.session, riskState: changed.to } },
          cfg,
        );
      }
    }
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
      pathOrTool: input.mcp?.tool ?? new URL(request.url).pathname,
      userId: input.userId,
      sessionId: session.id,
      runId: session.runId ?? runIdFromRequest(request),
      actorClass: actor.class,
      actorSignals: {
        tier: actor.tier,
        confidence: actor.confidence,
        score: actor.score,
        contributions: actor.contributions,
        facts: actor.facts,
        weightsVersion: actor.weightsVersion,
        sticky: actor.sticky,
        riskChange: risk,
        action: input.action,
        mode: input.mode,
        ...(input.mcp?.client ? { mcp: input.mcp.client } : {}),
        ...(input.mcp?.poppySession ? { poppySession: input.mcp.poppySession } : {}),
        ...(input.poppyApproval ? { poppyApproval: input.poppyApproval } : {}),
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

  // Poppy approval (FR44, control PP3), checked in Poppy's order. 1: the operation
  // is this session's, else the request is handled as if it had no approval.
  // 2: an operation already performed is reported as such, before preconditions
  // that would now fail. 3 (after the snapshot): the revision is the current one
  // for exactly this request. An X-HITL-Ticket header takes precedence.
  const approval = ticketId ? null : (input.poppyApproval ?? null);
  const found = approval ? await getTicket(db, approval.operation_id, now) : null;
  const op =
    found &&
    stateFailure(found, { userId: input.userId, sessionId: session.id }, now) !== "wrong_session"
      ? found
      : null;
  if (op?.state === "consumed") {
    const outcome = await ticketActionOutcome(db, op.id);
    const status =
      outcome === "executed" ? "performed" : outcome === "error" ? "failed" : "performing";
    await log({ outcome: "blocked", reason: `poppy:${status}`, ticketId: op.id });
    return { kind: "already_performed", actor, ticket: op, status };
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

  // Poppy check 3. A current revision runs only once the account holder has
  // approved with a passkey; before that the agent's approval is declined.
  if (approval && op) {
    const sameRequest =
      op.action === input.action && op.resourceId === input.resourceId && op.payloadHash === hash;
    const live = (op.state === "pending" || op.state === "approved") && op.expiresAt > now;
    if (sameRequest && live) {
      if (approval.revision !== revisionFor(op)) {
        await log({ outcome: "gated", reason: "poppy:revision_replaced", ticketId: op.id });
        return { kind: "gated", actor, ticket: op, reused: true };
      }
      if (op.state === "pending") {
        await log({ outcome: "blocked", reason: "poppy:agent_only_approval", ticketId: op.id });
        return { kind: "approval_declined", actor, ticket: op };
      }
      const redeemed = await redeemTicket(
        db,
        op.id,
        {
          userId: input.userId,
          action: input.action,
          resourceId: input.resourceId,
          payloadHash: hash,
          sessionId: session.id,
        },
        now,
      );
      if (redeemed.ok) return ok("ticket_consumed", op.id);
      await log({ outcome: "blocked", reason: `ticket:${redeemed.reason}`, ticketId: op.id });
      return { kind: "ticket_invalid", actor, ticketId: op.id, reason: redeemed.reason };
    }
  }

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
      clientId: input.mcp?.clientId ?? null,
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
