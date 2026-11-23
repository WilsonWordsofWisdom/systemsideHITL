// Console detail panel and reset (FR39, control L3; J11 ticket timeline, reset).
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSession, escalateRisk } from "@/lib/auth/session";
import {
  applications,
  hitlTickets,
  passkeys,
  requestLog,
  runs,
  sessions,
  users,
} from "@/lib/db/schema";
import type { AppDb } from "@/lib/db/types";
import { approvedNotRedeemed, sessionDetail, ticketDetail } from "@/lib/console/details";
import { setRunLabel } from "@/lib/console/queries";
import { resetDemoData } from "@/lib/console/reset";
import { approveTicket, redeemTicket, requestTicket } from "@/lib/hitl/tickets";
import { logEvent } from "@/lib/log";
import { createDraft } from "@/lib/journey/service";
import { DEMO_USER_ID } from "@/scripts/seed";
import { createTestDb } from "../helpers/db";

let db: AppDb;
let close: () => Promise<void>;
const t0 = new Date("2026-12-01T09:00:00Z");
const at = (s: number) => new Date(t0.getTime() + s * 1000);

beforeAll(async () => {
  ({ db, close } = await createTestDb({ seed: true }));
});
afterAll(async () => close());

async function ticket(sessionId: string) {
  return (
    await requestTicket(
      db,
      {
        userId: DEMO_USER_ID,
        action: "submit_application",
        resourceId: `res-${Math.random()}`,
        payloadHash: "h",
        preview: { summary: "Submit the application" },
        actor: { class: "suspected_agent", score: 70 },
        sessionId,
        ttlSeconds: 600,
      },
      t0,
    )
  ).ticket;
}

describe("ticket timeline", () => {
  it("shows created, approved with method and time to approve, then consumed", async () => {
    const { session } = await createSession(db, {
      userId: DEMO_USER_ID,
      signinMethod: "password",
      runId: "r42",
    });
    const t = await ticket(session.id);
    await approveTicket(
      db,
      t.id,
      { method: "passkey", meta: { approverSession: "approval" } },
      at(131),
    );
    const redemption = {
      userId: DEMO_USER_ID,
      action: t.action,
      resourceId: t.resourceId,
      payloadHash: "h",
      sessionId: session.id,
    };
    expect((await redeemTicket(db, t.id, redemption, at(140))).ok).toBe(true);
    await logEvent(db, {
      route: "api",
      method: "POST",
      pathOrTool: "/x",
      sessionId: session.id,
      ticketId: t.id,
      outcome: "executed",
      reason: "ticket_consumed",
    });

    const d = await ticketDetail(db, t.id, at(150));
    expect(d?.steps.map((s) => s.label)).toEqual(["Created", "Approved", "Consumed"]);
    expect(d?.steps[0].detail).toContain("suspected_agent");
    expect(d?.steps[1].detail).toContain("Passkey (UV)");
    expect(d?.steps[1].detail).toContain("2 min 11 s to approve");
    expect(d?.steps[1].detail).toContain("approval-only session");
    expect(d?.steps[2].detail).toContain("executed 1 time(s)");
    expect(d?.runId).toBe("r42");
    expect(d?.flag).toBeNull();
  });

  it("flags an approved ticket that expired unredeemed", async () => {
    const { session } = await createSession(db, { userId: DEMO_USER_ID, signinMethod: "password" });
    const t = await ticket(session.id);
    await approveTicket(db, t.id, { method: "passkey", meta: {} }, at(30));
    expect((await ticketDetail(db, t.id, at(300)))?.flag).toBeNull();
    expect((await ticketDetail(db, t.id, at(600)))?.flag).toBe("approved, not redeemed");
    expect(approvedNotRedeemed({ state: "consumed", expiresAt: at(0) }, at(600))).toBe(false);
  });

  it("returns null for an unknown ticket", async () => {
    expect(await ticketDetail(db, "hitl_nope")).toBeNull();
  });
});

describe("session timeline", () => {
  it("flags a probable handover when login and current class disagree", async () => {
    const { session } = await createSession(db, {
      userId: DEMO_USER_ID,
      signinMethod: "passkey",
      loginActorClass: "human",
    });
    await logEvent(db, {
      route: "api",
      method: "POST",
      pathOrTool: "/x",
      sessionId: session.id,
      actorClass: "suspected_agent",
      outcome: "gated",
    });
    const d = await sessionDetail(db, session.id);
    expect(d).toMatchObject({ currentClass: "suspected_agent", probableHandover: true });
  });

  it("flags handover_suspected even when the classes agree, and lists risk events", async () => {
    const { session } = await createSession(db, {
      userId: DEMO_USER_ID,
      signinMethod: "password",
      loginActorClass: "suspected_agent",
    });
    await logEvent(db, {
      route: "api",
      method: "POST",
      pathOrTool: "/x",
      sessionId: session.id,
      actorClass: "suspected_agent",
      outcome: "gated",
    });
    expect((await sessionDetail(db, session.id))?.probableHandover).toBe(false);
    await escalateRisk(db, session.id, "handover_suspected", "client_context_changed", {});
    const d = await sessionDetail(db, session.id);
    expect(d?.probableHandover).toBe(true);
    expect(d?.events.map((e) => e.trigger)).toEqual(["client_context_changed"]);
  });
});

describe("reset demo data (L3)", () => {
  it("clears logs, tickets, sessions and applications, restores the seed, keeps users, passkeys and runs", async () => {
    await db
      .insert(passkeys)
      .values({ userId: DEMO_USER_ID, credentialId: "cred-1", publicKey: "pk" });
    await setRunLabel(db, "r42", { agentLabel: "ChatGPT agent, web" });
    await createDraft(db, DEMO_USER_ID, "Extra draft");
    await db.update(users).set({ phone: "+1 555 0100" }).where(eq(users.id, DEMO_USER_ID));

    const removed = await resetDemoData(db);
    expect(removed.sessions).toBeGreaterThan(0);
    expect(removed.tickets).toBeGreaterThan(0);
    expect(removed.requestLog).toBeGreaterThan(0);

    expect(await db.select().from(requestLog)).toHaveLength(0);
    expect(await db.select().from(hitlTickets)).toHaveLength(0);
    expect(await db.select().from(sessions)).toHaveLength(0);
    const apps = await db.select().from(applications);
    expect(apps.map((a) => a.title).sort()).toEqual([
      "Autumn Craft Market",
      "Neighbourhood Garage Sale",
      "Summer Street Fair",
      "Winter Lights Walk",
    ]);
    expect(apps.find((a) => a.title === "Winter Lights Walk")?.status).toBe("draft");
    const [demo] = await db.select().from(users).where(eq(users.id, DEMO_USER_ID));
    expect(demo).toMatchObject({ phone: null, recoveryEmail: null });
    expect(demo.passwordHash).toBeTruthy();
    expect(await db.select().from(passkeys)).toHaveLength(1);
    expect((await db.select().from(runs)).map((r) => r.id)).toContain("r42");
  });
});
