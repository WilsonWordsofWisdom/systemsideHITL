// Session lifecycle (architecture 4.9 layer 1, controls S1, S8, S9).
// Only the SHA-256 of the cookie token is stored. Functions take `now` so tests
// can control time.
import { and, eq, isNull, ne } from "drizzle-orm";
import { sessionEvents, sessions } from "../db/schema";
import type { AppDb } from "../db/types";
import { hmacBase64Url, randomToken, safeEqual, sha256Hex } from "./crypto";

export const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const ABSOLUTE_LIFETIME_MS = 8 * 60 * 60 * 1000;

export type SessionRow = typeof sessions.$inferSelect;
type ActorClass = SessionRow["loginActorClass"];
type SigninMethod = SessionRow["signinMethod"];

export interface NewSession {
  userId: string;
  signinMethod: SigninMethod;
  loginSignals?: Record<string, unknown>;
  loginActorClass?: ActorClass;
  declaredAgent?: boolean;
  approvalOnly?: boolean;
  clientCtxHash?: string | null;
}

export async function createSession(db: AppDb, input: NewSession, now = new Date()) {
  const token = randomToken();
  const [session] = await db
    .insert(sessions)
    .values({
      id: sha256Hex(token),
      userId: input.userId,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + ABSOLUTE_LIFETIME_MS),
      signinMethod: input.signinMethod,
      loginSignals: input.loginSignals ?? {},
      loginActorClass: input.loginActorClass ?? "unknown",
      declaredAgent: input.declaredAgent ?? false,
      approvalOnly: input.approvalOnly ?? false,
      clientCtxHash: input.clientCtxHash ?? null,
    })
    .returning();
  return { token, session };
}

export async function revokeSession(db: AppDb, id: string, reason: string, now = new Date()) {
  const revoked = await db
    .update(sessions)
    .set({ revokedAt: now, revokeReason: reason })
    .where(and(eq(sessions.id, id), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });
  if (revoked.length > 0) {
    await db
      .insert(sessionEvents)
      .values({ sessionId: id, ts: now, event: "session_revoked", trigger: reason });
  }
  return revoked.length > 0;
}

// Ends every other live session of a user. Used when a passkey sign-in on /login
// resets the user's sessions (control S9); approval-only sessions are kept (W11).
export async function revokeOtherSessions(
  db: AppDb,
  userId: string,
  keepId: string,
  reason: string,
  now = new Date(),
) {
  // One update and one bulk insert, however many sessions the user has.
  const revoked = await db
    .update(sessions)
    .set({ revokedAt: now, revokeReason: reason })
    .where(
      and(
        eq(sessions.userId, userId),
        ne(sessions.id, keepId),
        isNull(sessions.revokedAt),
        eq(sessions.approvalOnly, false),
      ),
    )
    .returning({ id: sessions.id });
  if (revoked.length > 0) {
    await db.insert(sessionEvents).values(
      revoked.map((s) => ({
        sessionId: s.id,
        ts: now,
        event: "session_revoked",
        trigger: reason,
      })),
    );
  }
  return revoked.length;
}

// Returns the live session for a cookie token, or null. Expired sessions are
// revoked with a reason and an event; a valid one has last_seen_at refreshed.
export async function validateSession(
  db: AppDb,
  token: string | undefined | null,
  now = new Date(),
): Promise<SessionRow | null> {
  if (!token) return null;
  const id = sha256Hex(token);
  const [row] = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
  if (!row || row.revokedAt) return null;
  if (now.getTime() - row.lastSeenAt.getTime() > IDLE_TIMEOUT_MS) {
    await revokeSession(db, id, "idle", now);
    return null;
  }
  if (now.getTime() >= row.expiresAt.getTime()) {
    await revokeSession(db, id, "absolute", now);
    return null;
  }
  await db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, id));
  return { ...row, lastSeenAt: now };
}

// Session risk state (architecture 4.9 layer 3, controls A9, FR35). Escalate-only:
// clean -> agent_observed -> handover_suspected, never back down. A human takes a
// session back only by a fresh passkey sign-in, which starts a new clean session.
export type RiskState = SessionRow["riskState"];
const RISK_ORDER: Record<RiskState, number> = {
  clean: 0,
  agent_observed: 1,
  handover_suspected: 2,
};

export interface RiskEvidence {
  // Agent evidence from this request itself (tiers A-D), not carried over.
  agentEvidence: boolean;
  // The session was established with a human-leaning (passkey) login.
  humanLeaningLogin: boolean;
  // The session is used from a different client context than at sign-in (A8).
  contextChanged: boolean;
}

// The state this evidence moves the session to, or null if it stays put.
export function nextRiskState(
  current: RiskState,
  e: RiskEvidence,
): { to: RiskState; trigger: string } | null {
  if (current === "handover_suspected") return null;
  if (e.contextChanged) return { to: "handover_suspected", trigger: "client_context_changed" };
  if (e.agentEvidence && current === "clean") {
    return e.humanLeaningLogin
      ? { to: "handover_suspected", trigger: "agent_after_human_login" }
      : { to: "agent_observed", trigger: "agent_evidence" };
  }
  return null;
}

// Raises a live session's risk state and records the change. A request can never
// lower it: the update only matches rows currently below the target state.
export async function escalateRisk(
  db: AppDb,
  sessionId: string,
  to: RiskState,
  trigger: string,
  signals: Record<string, unknown> = {},
  now = new Date(),
): Promise<{ from: RiskState; to: RiskState } | null> {
  const [row] = await db
    .select({ riskState: sessions.riskState, revokedAt: sessions.revokedAt })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!row || row.revokedAt || RISK_ORDER[row.riskState] >= RISK_ORDER[to]) return null;
  const [changed] = await db
    .update(sessions)
    .set({ riskState: to })
    .where(
      and(
        eq(sessions.id, sessionId),
        eq(sessions.riskState, row.riskState),
        isNull(sessions.revokedAt),
      ),
    )
    .returning({ id: sessions.id });
  // Another request escalated it first; its event records that change.
  if (!changed) return null;
  await db.insert(sessionEvents).values({
    sessionId,
    ts: now,
    event: "risk_changed",
    fromState: row.riskState,
    toState: to,
    trigger,
    signals,
  });
  return { from: row.riskState, to };
}

// CSRF token bound to the session (control S2). Stateless: derived with HMAC.
export function csrfTokenFor(sessionId: string, secret: string): string {
  return hmacBase64Url(secret, `csrf:${sessionId}`);
}

export function verifyCsrf(sessionId: string, token: string | null | undefined, secret: string) {
  return !!token && safeEqual(token, csrfTokenFor(sessionId, secret));
}
