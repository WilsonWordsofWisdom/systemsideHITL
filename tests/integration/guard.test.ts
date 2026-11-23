// hitlGuard end to end against the database (controls C1-C4, S10, T1, T6, T9, L1;
// J02 gating and tamper cases, J07 bypass cases).
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSession, type SessionRow } from "@/lib/auth/session";
import {
  applications,
  clientSignals,
  hitlTickets,
  rateLimits,
  requestLog,
  sessionEvents,
  sessions,
} from "@/lib/db/schema";
import type { AppDb } from "@/lib/db/types";
import { getClassifierConfig, classifyActor } from "@/lib/hitl/classifier";
import { TICKET_USER_LIMIT, hitlGuard, type GuardInput } from "@/lib/hitl/guard";
import { getPolicy } from "@/lib/hitl/policy";
import { clientContextHash } from "@/lib/hitl/inputs";
import { approveTicket } from "@/lib/hitl/tickets";
import { JourneyError, createDraft, submitApplication, updateDraft } from "@/lib/journey/service";
import { DEMO_USER_ID } from "@/scripts/seed";
import { createTestDb } from "../helpers/db";

let db: AppDb;
let close: () => Promise<void>;
const SECRET = "test-session-secret-0123456789abcdef";
const SUBMITTED_APP = "00000000-0000-4000-8000-000000000102";
const ORIGIN = "http://localhost:3100";
const BROWSER_HEADERS = {
  "user-agent": "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
  "accept-language": "en",
  "sec-fetch-site": "same-origin",
};

beforeAll(async () => {
  ({ db, close } = await createTestDb({ seed: true }));
});
afterAll(async () => close());
beforeEach(async () => {
  await db.delete(rateLimits);
});

async function session(
  over: Partial<Parameters<typeof createSession>[1]> = {},
): Promise<SessionRow> {
  return (await createSession(db, { userId: DEMO_USER_ID, signinMethod: "password", ...over }))
    .session;
}

async function completeDraft(attendance = "80") {
  const app = await createDraft(db, DEMO_USER_ID, "Riverside Picnic");
  await updateDraft(db, DEMO_USER_ID, app.id, {
    date: "2026-12-12",
    attendance,
    location: "Riverside Park",
  });
  return app.id;
}

function input(
  s: SessionRow,
  over: Partial<GuardInput> & { headers?: Record<string, string> } = {},
): GuardInput {
  const { headers, ...rest } = over;
  return {
    db,
    request: new Request(`${ORIGIN}/api/applications/x/submit`, {
      method: "POST",
      headers: { ...BROWSER_HEADERS, ...headers },
    }),
    route: "api",
    userId: DEMO_USER_ID,
    session: s,
    action: "submit_application",
    resourceId: null,
    body: { declaration: "on" },
    secret: SECRET,
    mode: "enforce",
    ttlSeconds: 600,
    ...rest,
  };
}

const logsFor = (sessionId: string) =>
  db.select().from(requestLog).where(eq(requestLog.sessionId, sessionId));

describe("decisions", () => {
  it("allows a low-risk action and logs it once the action finishes", async () => {
    const s = await session();
    const g = await hitlGuard(input(s, { action: "create_draft" }));
    expect(g.kind).toBe("ok");
    expect(await logsFor(s.id)).toHaveLength(0);
    if (g.kind === "ok") await g.finish("executed");
    const [row] = await logsFor(s.id);
    expect(row).toMatchObject({
      outcome: "executed",
      policyDecision: "allow",
      actorClass: "unknown",
    });
  });

  it("gates submit with the requires_human_approval ticket and logs it", async () => {
    const s = await session();
    const id = await completeDraft();
    const g = await hitlGuard(input(s, { resourceId: id }));
    expect(g.kind).toBe("gated");
    if (g.kind !== "gated") return;
    expect(g.ticket).toMatchObject({
      state: "pending",
      action: "submit_application",
      resourceId: id,
      requestingSessionId: s.id,
    });
    expect(g.ticket.payloadPreview).toMatchObject({ title: "Riverside Picnic" });
    // The hashed request fields, without volatile ones, for the Continue button.
    expect((g.ticket.payloadPreview as { request: unknown }).request).toEqual({
      declaration: "on",
    });
    const [row] = await logsFor(s.id);
    expect(row).toMatchObject({
      outcome: "gated",
      policyDecision: "gate",
      ticketId: g.ticket.id,
      reason: "ticket_created",
    });
    const [app] = await db.select().from(applications).where(eq(applications.id, id));
    expect(app.status).toBe("draft");
  });

  it("denies update_contact for a declared agent with the policy reason", async () => {
    const s = await session({ declaredAgent: true, loginActorClass: "declared_agent" });
    const g = await hitlGuard(
      input(s, { action: "update_contact", body: { phone: "+1 555 0100" } }),
    );
    expect(g).toMatchObject({ kind: "denied", reason: "policy" });
    const [row] = await logsFor(s.id);
    expect(row).toMatchObject({
      outcome: "blocked",
      policyDecision: "deny",
      actorClass: "declared_agent",
    });
  });

  it("denies delete for a suspected agent but gates it for a declared one", async () => {
    const id = await completeDraft();
    const suspected = await session();
    const automated = await hitlGuard(
      input(suspected, {
        action: "delete_application",
        resourceId: id,
        body: {},
        headers: {
          "user-agent": "HeadlessChrome/140",
          "accept-language": "",
          "sec-fetch-site": "",
        },
      }),
    );
    expect(automated.actor.class).toBe("suspected_agent");
    expect(automated.kind).toBe("denied");
    const declared = await session({ declaredAgent: true });
    expect(
      (await hitlGuard(input(declared, { action: "delete_application", resourceId: id, body: {} })))
        .kind,
    ).toBe("gated");
  });

  it("denies an unlisted mutating action (C4)", async () => {
    const s = await session();
    expect((await hitlGuard(input(s, { action: "transfer_funds" }))).kind).toBe("denied");
  });

  it("a valid session cookie alone never performs a high-risk action (S10)", async () => {
    // A passkey session with human-like behaviour: the strongest human evidence there is.
    const s = await session({ signinMethod: "passkey", loginActorClass: "human" });
    await db.insert(clientSignals).values({
      sessionId: s.id,
      payload: {
        webdriver: false,
        pointerMoves: 40,
        clicks: 2,
        keys: 9,
        untrusted: 0,
        msOnPage: 9000,
      },
    });
    const draft = await completeDraft();
    const calls: Partial<GuardInput>[] = [
      { action: "submit_application", resourceId: draft },
      { action: "pay_fee", resourceId: SUBMITTED_APP, body: {} },
      { action: "update_contact", body: { phone: "+1 555 0100" } },
      { action: "delete_application", resourceId: draft, body: {} },
    ];
    for (const c of calls) {
      const g = await hitlGuard(input(s, c));
      expect(g.actor.class).toBe("human");
      expect(g.kind, c.action).toBe("gated");
    }
  });

  it("records an API call with no prior page view as a signal (J07)", async () => {
    const s = await session();
    const id = await completeDraft();
    await hitlGuard(input(s, { resourceId: id }));
    const [row] = await logsFor(s.id);
    expect(row.actorSignals).toMatchObject({
      contributions: { no_prior_page_view: 10 },
      facts: { noPriorPageView: true },
    });
  });

  it("reclassifies a human login whose requests look automated (T10)", async () => {
    const s = await session({ signinMethod: "passkey", loginActorClass: "human" });
    await db
      .insert(clientSignals)
      .values({ sessionId: s.id, payload: { webdriver: true, untrusted: 4 } });
    const g = await hitlGuard(
      input(s, { action: "update_contact", body: { phone: "+1 555 0100" } }),
    );
    expect(g.actor.class).toBe("suspected_agent");
    expect(g.kind).toBe("denied");
  });
});

describe("fail closed (C3)", () => {
  const throwing = {
    policy: getPolicy,
    classifierConfig: getClassifierConfig,
    classify: (() => {
      throw new Error("classifier down");
    }) as unknown as typeof classifyActor,
  };

  it("a classifier error turns allow into gate, never allow", async () => {
    const s = await session();
    const id = await completeDraft();
    // update_draft is normally allowed for everyone.
    const g = await hitlGuard(
      input(s, { action: "update_draft", resourceId: id, body: { attendance: "90" } }),
      throwing,
    );
    expect(g.kind).toBe("gated");
    expect((await hitlGuard(input(s, { resourceId: id }), throwing)).kind).toBe("gated");
    const rows = await logsFor(s.id);
    expect(rows).toHaveLength(2);
    for (const r of rows)
      expect(r.actorSignals).toMatchObject({ facts: { classifierError: true } });
  });

  it("a classifier error denies critical actions", async () => {
    const s = await session();
    const g = await hitlGuard(
      input(s, { action: "update_contact", body: { phone: "+1 555 0100" } }),
      throwing,
    );
    expect(g.kind).toBe("denied");
    const [row] = await logsFor(s.id);
    expect(row.reason).toBe("classifier_error");
  });
});

describe("tickets through the guard", () => {
  it("an approved retry executes once; a replay is rejected as consumed (T3, T6)", async () => {
    const s = await session();
    const id = await completeDraft();
    const g = await hitlGuard(input(s, { resourceId: id }));
    if (g.kind !== "gated") throw new Error("expected gated");
    await approveTicket(db, g.ticket.id, { method: "passkey", meta: {} });
    const retry = await hitlGuard(
      input(s, { resourceId: id, headers: { "x-hitl-ticket": g.ticket.id } }),
    );
    expect(retry.kind).toBe("ok");
    const replay = await hitlGuard(
      input(s, { resourceId: id, headers: { "x-hitl-ticket": g.ticket.id } }),
    );
    expect(replay).toMatchObject({ kind: "ticket_invalid", reason: "consumed" });
  });

  it("a replay after the action ran is reported as consumed, not as the action's error", async () => {
    const s = await session();
    const id = await completeDraft();
    const g = await hitlGuard(input(s, { resourceId: id }));
    if (g.kind !== "gated") throw new Error("expected gated");
    await approveTicket(db, g.ticket.id, { method: "passkey", meta: {} });
    const headers = { "x-hitl-ticket": g.ticket.id };
    expect((await hitlGuard(input(s, { resourceId: id, headers }))).kind).toBe("ok");
    await submitApplication(db, DEMO_USER_ID, id);
    const replay = await hitlGuard(input(s, { resourceId: id, headers }));
    expect(replay).toMatchObject({ kind: "ticket_invalid", reason: "consumed" });
  });

  it("accepts the ticket from the form field too", async () => {
    const s = await session();
    const id = await completeDraft();
    const g = await hitlGuard(input(s, { resourceId: id }));
    if (g.kind !== "gated") throw new Error("expected gated");
    await approveTicket(db, g.ticket.id, { method: "passkey", meta: {} });
    const retry = await hitlGuard(
      input(s, { resourceId: id, body: { declaration: "on", hitl_ticket: g.ticket.id } }),
    );
    expect(retry.kind).toBe("ok");
  });

  it("editing the draft after approval needs a new approval (T5)", async () => {
    const s = await session();
    const id = await completeDraft("80");
    const g = await hitlGuard(input(s, { resourceId: id }));
    if (g.kind !== "gated") throw new Error("expected gated");
    await approveTicket(db, g.ticket.id, { method: "passkey", meta: {} });
    await updateDraft(db, DEMO_USER_ID, id, { attendance: "800" });
    const retry = await hitlGuard(
      input(s, { resourceId: id, headers: { "x-hitl-ticket": g.ticket.id } }),
    );
    expect(retry).toMatchObject({ kind: "ticket_invalid", reason: "payload_mismatch" });
  });

  it("another session of the same user can't redeem it (FR19)", async () => {
    const s = await session();
    const other = await session();
    const id = await completeDraft();
    const g = await hitlGuard(input(s, { resourceId: id }));
    if (g.kind !== "gated") throw new Error("expected gated");
    await approveTicket(db, g.ticket.id, { method: "passkey", meta: {} });
    const retry = await hitlGuard(
      input(other, { resourceId: id, headers: { "x-hitl-ticket": g.ticket.id } }),
    );
    expect(retry).toMatchObject({ kind: "ticket_invalid", reason: "wrong_session" });
    const [row] = await logsFor(other.id);
    expect(row.reason).toBe("ticket:wrong_session");
  });

  it("a repeated identical submit reuses the pending ticket; a change supersedes it", async () => {
    const s = await session();
    const id = await completeDraft("80");
    const first = await hitlGuard(input(s, { resourceId: id }));
    const again = await hitlGuard(input(s, { resourceId: id }));
    if (first.kind !== "gated" || again.kind !== "gated") throw new Error("expected gated");
    expect(again.ticket.id).toBe(first.ticket.id);
    expect(again.reused).toBe(true);

    await updateDraft(db, DEMO_USER_ID, id, { attendance: "120" });
    const changed = await hitlGuard(input(s, { resourceId: id }));
    if (changed.kind !== "gated") throw new Error("expected gated");
    expect(changed.ticket.id).not.toBe(first.ticket.id);
    const [old] = await db.select().from(hitlTickets).where(eq(hitlTickets.id, first.ticket.id));
    expect(old).toMatchObject({ state: "rejected", rejectReason: "superseded" });
  });

  it("refuses an action that could not run, without creating a ticket", async () => {
    const s = await session();
    const draft = await createDraft(db, DEMO_USER_ID, "Incomplete");
    await expect(hitlGuard(input(s, { resourceId: draft.id }))).rejects.toBeInstanceOf(
      JourneyError,
    );
    await expect(
      hitlGuard(input(s, { action: "pay_fee", resourceId: draft.id, body: {} })),
    ).rejects.toMatchObject({ code: "invalid_state" });
    const tickets = await db
      .select()
      .from(hitlTickets)
      .where(eq(hitlTickets.requestingSessionId, s.id));
    expect(tickets).toHaveLength(0);
    const rows = await logsFor(s.id);
    expect(rows.map((r) => r.reason)).toEqual([
      "precondition:incomplete",
      "precondition:invalid_state",
    ]);
  });

  it("rate limits ticket creation per user without creating more tickets (T9, FR23)", async () => {
    const s = await session();
    for (let i = 0; i < TICKET_USER_LIMIT.max; i++) {
      const id = await completeDraft();
      expect((await hitlGuard(input(s, { resourceId: id }))).kind).toBe("gated");
    }
    const id = await completeDraft();
    expect(await hitlGuard(input(s, { resourceId: id }))).toMatchObject({
      kind: "denied",
      reason: "rate_limited",
    });
    const tickets = await db.select().from(hitlTickets).where(eq(hitlTickets.resourceId, id));
    expect(tickets).toHaveLength(0);
  });
});

describe("observe mode (T12)", () => {
  it("logs the decision and lets the action run", async () => {
    const s = await session();
    const id = await completeDraft();
    const g = await hitlGuard(input(s, { resourceId: id, mode: "observe" }));
    expect(g.kind).toBe("ok");
    if (g.kind === "ok") await g.finish("executed");
    const [row] = await logsFor(s.id);
    expect(row).toMatchObject({
      outcome: "executed",
      policyDecision: "gate",
      reason: "observe:gate",
    });
    const tickets = await db
      .select()
      .from(hitlTickets)
      .where(eq(hitlTickets.requestingSessionId, s.id));
    expect(tickets).toHaveLength(0);
  });
});

describe("logging (L1)", () => {
  it("every guard outcome writes exactly one row", async () => {
    const s = await session();
    const id = await completeDraft();
    await hitlGuard(input(s, { resourceId: id })); // gated
    await hitlGuard(input(s, { action: "transfer_funds" })); // denied
    await hitlGuard(input(s, { resourceId: id, headers: { "x-hitl-ticket": "hitl_nope" } })); // invalid
    const ok = await hitlGuard(input(s, { action: "create_draft" }));
    if (ok.kind === "ok") await ok.finish("error", "invalid_input");
    const rows = await logsFor(s.id);
    expect(rows.map((r) => r.outcome).sort()).toEqual(["blocked", "blocked", "error", "gated"]);
    for (const r of rows) {
      expect(r.ipHash).toBeTruthy();
      expect(r.ipHash).not.toContain("unknown");
    }
  });

  it("a session's own row is used for the class, not a cached value", async () => {
    const s = await session();
    await db.update(sessions).set({ riskState: "agent_observed" }).where(eq(sessions.id, s.id));
    const [fresh] = await db.select().from(sessions).where(eq(sessions.id, s.id));
    const g = await hitlGuard(
      input(fresh, { action: "update_contact", body: { phone: "+1 555 0100" } }),
    );
    expect(g.actor).toMatchObject({ class: "suspected_agent", sticky: true });
  });
});

describe("session handover (T10a-c, FR35-FR38)", () => {
  const humanSnapshot = {
    webdriver: false,
    pointerMoves: 40,
    clicks: 2,
    keys: 9,
    untrusted: 0,
    msOnPage: 9000,
  };
  const browserRequest = () =>
    new Request(`${ORIGIN}/api/account/contact`, { method: "POST", headers: BROWSER_HEADERS });
  const riskOf = async (id: string) =>
    (await db.select().from(sessions).where(eq(sessions.id, id)))[0].riskState;
  const eventsOf = (id: string) =>
    db.select().from(sessionEvents).where(eq(sessionEvents.sessionId, id));

  it("T10a: human to undetected agent: high-risk actions stay gated, contact change gated not denied", async () => {
    const s = await session({
      signinMethod: "passkey",
      loginActorClass: "human",
      clientCtxHash: clientContextHash(browserRequest(), SECRET),
    });
    await db.insert(clientSignals).values({ sessionId: s.id, payload: humanSnapshot });
    const contact = await hitlGuard(
      input(s, { action: "update_contact", body: { phone: "+1 555 0100" } }),
    );
    expect(contact.actor.class).toBe("human");
    expect(contact.kind).toBe("gated");
    expect(await riskOf(s.id)).toBe("clean");
  });

  it("agent evidence after a human-leaning login escalates to handover_suspected", async () => {
    const s = await session({ signinMethod: "passkey", loginActorClass: "human" });
    await db.insert(clientSignals).values({ sessionId: s.id, payload: { webdriver: true } });
    await hitlGuard(input(s, { action: "create_draft" }));
    expect(await riskOf(s.id)).toBe("handover_suspected");
    const [event] = await eventsOf(s.id);
    expect(event).toMatchObject({
      event: "risk_changed",
      fromState: "clean",
      toState: "handover_suspected",
      trigger: "agent_after_human_login",
    });
  });

  it("T10b: agent to human: the session stays above clean and contact changes stay denied", async () => {
    const s = await session();
    await db.insert(clientSignals).values({ sessionId: s.id, payload: { webdriver: true } });
    await hitlGuard(input(s, { action: "create_draft" }));
    expect(await riskOf(s.id)).toBe("agent_observed");

    // The human takes over in the same session: behaviour now looks human.
    await db.delete(clientSignals).where(eq(clientSignals.sessionId, s.id));
    await db.insert(clientSignals).values({ sessionId: s.id, payload: humanSnapshot });
    const [fresh] = await db.select().from(sessions).where(eq(sessions.id, s.id));
    const g = await hitlGuard(
      input(fresh, { action: "update_contact", body: { phone: "+1 555 0100" } }),
    );
    expect(g.actor).toMatchObject({ class: "suspected_agent", sticky: true });
    expect(g.kind).toBe("denied");
    expect(await riskOf(s.id)).toBe("agent_observed");
  });

  it("T10c: a cookie copied into a script is flagged and the gate holds", async () => {
    const s = await session({
      signinMethod: "passkey",
      loginActorClass: "human",
      clientCtxHash: clientContextHash(browserRequest(), SECRET),
    });
    await db.insert(clientSignals).values({ sessionId: s.id, payload: humanSnapshot });
    const id = await completeDraft();
    // Same cookie, different client: a script with its own user agent.
    const g = await hitlGuard(
      input(s, {
        resourceId: id,
        headers: {
          "user-agent": "python-requests/2.32",
          "accept-language": "",
          "sec-fetch-site": "",
        },
      }),
    );
    expect(g.kind).toBe("gated");
    expect(g.actor.class).toBe("suspected_agent");
    expect(await riskOf(s.id)).toBe("handover_suspected");
    const [event] = await eventsOf(s.id);
    expect(event).toMatchObject({
      trigger: "client_context_changed",
      toState: "handover_suspected",
    });
    const [row] = await logsFor(s.id);
    expect(row.actorSignals).toMatchObject({
      riskChange: { from: "clean", to: "handover_suspected", trigger: "client_context_changed" },
    });
  });

  it("the escalation applies to the request that caused it", async () => {
    // Context change alone scores 30, below the suspect threshold; the new risk
    // state makes this same request a suspected agent, so the contact change is denied.
    const s = await session({
      signinMethod: "passkey",
      loginActorClass: "human",
      clientCtxHash: clientContextHash(browserRequest(), SECRET),
    });
    await db.insert(clientSignals).values({ sessionId: s.id, payload: humanSnapshot });
    const g = await hitlGuard(
      input(s, {
        action: "update_contact",
        body: { phone: "+1 555 0100" },
        headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/140.0.0.0 Safari/537.36" },
      }),
    );
    expect(g.actor.contributions).toMatchObject({ client_context_changed: 30 });
    expect(g.actor.class).toBe("suspected_agent");
    expect(g.kind).toBe("denied");
  });
});
