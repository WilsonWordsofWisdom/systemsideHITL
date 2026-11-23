// Session lifecycle: J06 "Sessions expire" and "Session rotates at sign-in", controls S1, S8, S9.
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/auth/crypto";
import {
  ABSOLUTE_LIFETIME_MS,
  IDLE_TIMEOUT_MS,
  createSession,
  csrfTokenFor,
  escalateRisk,
  revokeOtherSessions,
  revokeSession,
  validateSession,
  verifyCsrf,
} from "@/lib/auth/session";
import { sessionEvents, sessions } from "@/lib/db/schema";
import type { AppDb } from "@/lib/db/types";
import { DEMO_USER_ID } from "@/scripts/seed";
import { createTestDb } from "../helpers/db";

let db: AppDb;
let close: () => Promise<void>;
const t0 = new Date("2026-12-01T09:00:00Z");
const at = (ms: number) => new Date(t0.getTime() + ms);
const MIN = 60 * 1000;

beforeAll(async () => {
  ({ db, close } = await createTestDb({ seed: true }));
});
afterAll(async () => close());

async function events(sessionId: string) {
  return db.select().from(sessionEvents).where(eq(sessionEvents.sessionId, sessionId));
}

describe("sessions", () => {
  it("stores only the hash of the token", async () => {
    const { token, session } = await createSession(
      db,
      { userId: DEMO_USER_ID, signinMethod: "password" },
      t0,
    );
    expect(session.id).toBe(sha256Hex(token));
    expect(session.id).not.toContain(token);
    expect(session.expiresAt.getTime()).toBe(t0.getTime() + ABSOLUTE_LIFETIME_MS);
    expect(session.riskState).toBe("clean");
  });

  it("keeps an active session alive and refreshes last_seen_at", async () => {
    const { token } = await createSession(
      db,
      { userId: DEMO_USER_ID, signinMethod: "password" },
      t0,
    );
    const s = await validateSession(db, token, at(10 * MIN));
    expect(s?.lastSeenAt.getTime()).toBe(at(10 * MIN).getTime());
    // 25 more minutes is within 30 minutes of the last request.
    expect(await validateSession(db, token, at(35 * MIN))).not.toBeNull();
  });

  it("revokes after 30 minutes idle and records the reason", async () => {
    const { token, session } = await createSession(
      db,
      { userId: DEMO_USER_ID, signinMethod: "password" },
      t0,
    );
    expect(await validateSession(db, token, at(IDLE_TIMEOUT_MS + MIN))).toBeNull();
    const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id));
    expect(row.revokeReason).toBe("idle");
    expect((await events(session.id)).map((e) => [e.event, e.trigger])).toEqual([
      ["session_revoked", "idle"],
    ]);
    // Once revoked it stays revoked.
    expect(await validateSession(db, token, at(IDLE_TIMEOUT_MS + 2 * MIN))).toBeNull();
  });

  it("revokes after 8 hours even with requests every minute", async () => {
    const { token, session } = await createSession(
      db,
      { userId: DEMO_USER_ID, signinMethod: "password" },
      t0,
    );
    let now = t0.getTime();
    while (now < t0.getTime() + ABSOLUTE_LIFETIME_MS - 20 * MIN) {
      now += 20 * MIN;
      expect(await validateSession(db, token, new Date(now))).not.toBeNull();
    }
    expect(await validateSession(db, token, at(ABSOLUTE_LIFETIME_MS))).toBeNull();
    const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id));
    expect(row.revokeReason).toBe("absolute");
  });

  it("rejects unknown, empty and revoked tokens", async () => {
    expect(await validateSession(db, "not-a-real-token", t0)).toBeNull();
    expect(await validateSession(db, undefined, t0)).toBeNull();
    const { token, session } = await createSession(
      db,
      { userId: DEMO_USER_ID, signinMethod: "password" },
      t0,
    );
    expect(await revokeSession(db, session.id, "signed_out", t0)).toBe(true);
    expect(await revokeSession(db, session.id, "signed_out", t0)).toBe(false);
    expect(await validateSession(db, token, t0)).toBeNull();
  });

  it("ends a user's other sessions but keeps approval-only ones (S9, W11)", async () => {
    const userDb = db;
    const a = await createSession(userDb, { userId: DEMO_USER_ID, signinMethod: "password" }, t0);
    const approval = await createSession(
      userDb,
      { userId: DEMO_USER_ID, signinMethod: "passkey", approvalOnly: true },
      t0,
    );
    const fresh = await createSession(
      userDb,
      { userId: DEMO_USER_ID, signinMethod: "passkey" },
      t0,
    );
    await revokeOtherSessions(userDb, DEMO_USER_ID, fresh.session.id, "passkey_reset", t0);
    expect(await validateSession(userDb, a.token, t0)).toBeNull();
    expect(await validateSession(userDb, approval.token, t0)).not.toBeNull();
    expect(await validateSession(userDb, fresh.token, t0)).not.toBeNull();
  });
});

describe("CSRF tokens", () => {
  const secret = "s".repeat(32);
  it("verify only for the session they were made for", () => {
    const token = csrfTokenFor("session-a", secret);
    expect(verifyCsrf("session-a", token, secret)).toBe(true);
    expect(verifyCsrf("session-b", token, secret)).toBe(false);
    expect(verifyCsrf("session-a", undefined, secret)).toBe(false);
    expect(verifyCsrf("session-a", token, "t".repeat(32))).toBe(false);
  });
});

describe("risk state (A9, FR35)", () => {
  it("escalates once, records the change, and never goes back down", async () => {
    const { session } = await createSession(
      db,
      { userId: DEMO_USER_ID, signinMethod: "password" },
      t0,
    );
    expect(
      await escalateRisk(db, session.id, "agent_observed", "agent_evidence", { score: 50 }, t0),
    ).toEqual({
      from: "clean",
      to: "agent_observed",
    });
    // Same or lower target: no change and no event.
    expect(
      await escalateRisk(db, session.id, "agent_observed", "agent_evidence", {}, t0),
    ).toBeNull();
    expect(await escalateRisk(db, session.id, "clean", "reset", {}, t0)).toBeNull();
    expect(
      await escalateRisk(
        db,
        session.id,
        "handover_suspected",
        "client_context_changed",
        {},
        at(MIN),
      ),
    ).toEqual({ from: "agent_observed", to: "handover_suspected" });

    const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id));
    expect(row.riskState).toBe("handover_suspected");
    const events = await db
      .select()
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, session.id))
      .orderBy(sessionEvents.ts);
    expect(events.map((e) => [e.event, e.fromState, e.toState, e.trigger])).toEqual([
      ["risk_changed", "clean", "agent_observed", "agent_evidence"],
      ["risk_changed", "agent_observed", "handover_suspected", "client_context_changed"],
    ]);
    expect(events[0].signals).toEqual({ score: 50 });
  });

  it("doesn't change an ended session, and ending one keeps its events", async () => {
    const { session } = await createSession(
      db,
      { userId: DEMO_USER_ID, signinMethod: "password" },
      t0,
    );
    await escalateRisk(db, session.id, "agent_observed", "agent_evidence", {}, t0);
    await revokeSession(db, session.id, "rotated", at(MIN));
    expect(
      await escalateRisk(db, session.id, "handover_suspected", "x", {}, at(2 * MIN)),
    ).toBeNull();
    const events = await db
      .select()
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, session.id));
    expect(events.map((e) => e.event).sort()).toEqual(["risk_changed", "session_revoked"]);
  });

  it("a fresh passkey sign-in starts a clean session and ends the risky one (T10b)", async () => {
    const risky = await createSession(db, { userId: DEMO_USER_ID, signinMethod: "password" }, t0);
    await escalateRisk(db, risky.session.id, "agent_observed", "agent_evidence", {}, t0);
    const fresh = await createSession(
      db,
      { userId: DEMO_USER_ID, signinMethod: "passkey" },
      at(MIN),
    );
    await revokeOtherSessions(db, DEMO_USER_ID, fresh.session.id, "passkey_reset", at(MIN));
    expect(fresh.session.riskState).toBe("clean");
    expect(await validateSession(db, risky.token, at(MIN))).toBeNull();
  });
});
