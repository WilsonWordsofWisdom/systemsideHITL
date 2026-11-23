import "server-only";
import { NextResponse } from "next/server";
import { appConfig } from "../app";
import { getSessionSecret } from "../auth/crypto";
import { getApproverSession } from "../auth/current";
import { verifyCsrf } from "../auth/session";
import { getDb } from "../db/server";
import { clientIp, ipHash, isSameOrigin } from "../http";
import { logEvent } from "../log";
import { lockedUntil, recordFailure } from "../ratelimit";
import { APPROVE_IP_LIMIT, APPROVE_USER_LIMIT } from "./approval";
import { getTicket, type Ticket } from "./tickets";

type Approver = NonNullable<Awaited<ReturnType<typeof getApproverSession>>>;

export interface ApproveContext {
  db: ReturnType<typeof getDb>;
  approver: Approver;
  ticket: Ticket;
  now: Date;
  // Logs the attempt to request_log; failures also count toward the rate limit.
  record: (outcome: "executed" | "blocked", reason: string, extra?: object) => Promise<void>;
}

// Common checks for /api/hitl/[ticketId]/{webauthn/options,approve,reject}:
// same origin (W4), an approver session of the ticket's user (W3), CSRF, and the
// approval rate limit (T9). Returns a response to send instead when a check fails.
export async function approveContext(
  request: Request,
  ticketId: string,
  csrfFromBody?: string,
): Promise<{ ok: true; ctx: ApproveContext } | { ok: false; response: NextResponse }> {
  const fail = (status: number, error: string) => ({
    ok: false as const,
    response: NextResponse.json({ error }, { status }),
  });
  const cfg = appConfig();
  if (!isSameOrigin(request, cfg.appOrigin)) return fail(403, "bad_request");

  const approver = await getApproverSession();
  if (!approver) return fail(401, "unauthenticated");
  const secret = getSessionSecret();
  const csrf = request.headers.get("x-csrf-token") ?? csrfFromBody;
  if (!verifyCsrf(approver.session.id, csrf, secret)) return fail(403, "csrf");

  const db = getDb();
  const now = new Date();
  const ip = ipHash(clientIp(request), secret);
  const userKey = `approve:user:${approver.user.id}`;
  const ipKey = `approve:ip:${ip}`;

  const record: ApproveContext["record"] = async (outcome, reason, extra = {}) => {
    await logEvent(db, {
      route: "web",
      method: request.method,
      pathOrTool: new URL(request.url).pathname,
      userId: approver.user.id,
      sessionId: approver.session.id,
      ticketId,
      outcome,
      reason,
      actorSignals: { approverSession: approver.kind, ...extra },
      userAgent: (request.headers.get("user-agent") ?? "").slice(0, 300),
      ipHash: ip,
    });
    if (outcome === "blocked") {
      await recordFailure(db, userKey, APPROVE_USER_LIMIT, now);
      await recordFailure(db, ipKey, APPROVE_IP_LIMIT, now);
    }
  };

  if ((await lockedUntil(db, userKey, now)) || (await lockedUntil(db, ipKey, now))) {
    return fail(429, "rate_limited");
  }
  const ticket = await getTicket(db, ticketId, now);
  // Another user's ticket looks the same as a missing one (no probing).
  if (!ticket || ticket.userId !== approver.user.id) {
    await record("blocked", ticket ? "wrong_account" : "not_found");
    return fail(404, "not_found");
  }
  return { ok: true, ctx: { db, approver, ticket, now, record } };
}
