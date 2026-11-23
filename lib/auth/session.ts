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

// CSRF token bound to the session (control S2). Stateless: derived with HMAC.
export function csrfTokenFor(sessionId: string, secret: string): string {
  return hmacBase64Url(secret, `csrf:${sessionId}`);
}

export function verifyCsrf(sessionId: string, token: string | null | undefined, secret: string) {
  return !!token && safeEqual(token, csrfTokenFor(sessionId, secret));
}
