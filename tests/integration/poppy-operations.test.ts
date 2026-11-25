// Poppy Operations approvals through hitlGuard (J13 T17, T18; FR44; control PP3):
// an approval from the agent alone never performs an irreversible step; after the
// account holder's passkey approval the revision changes, and an approval of that
// revision is performed exactly once.
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSession, type SessionRow } from "@/lib/auth/session";
import { applications, hitlTickets, rateLimits, requestLog } from "@/lib/db/schema";
import type { AppDb } from "@/lib/db/types";
import { hitlGuard, type GuardInput, type GuardResult } from "@/lib/hitl/guard";
import { approveTicket, type Ticket } from "@/lib/hitl/tickets";
import { createDraft, submitApplication, updateDraft } from "@/lib/journey/service";
import { revisionFor, type PoppyApproval } from "@/lib/poppy/operations";
import { DEMO_USER_ID } from "@/scripts/seed";
import { createTestDb } from "../helpers/db";

let db: AppDb;
let close: () => Promise<void>;
const SECRET = "test-session-secret-0123456789abcdef";

beforeAll(async () => {
  ({ db, close } = await createTestDb({ seed: true }));
});
afterAll(async () => close());
beforeEach(async () => {
  await db.delete(rateLimits);
});

const session = async (): Promise<SessionRow> =>
  (await createSession(db, { userId: DEMO_USER_ID, signinMethod: "password" })).session;

async function draft(attendance = "80") {
  const app = await createDraft(db, DEMO_USER_ID, "Riverside Picnic");
  await updateDraft(db, DEMO_USER_ID, app.id, {
    date: "2026-12-12",
    attendance,
    location: "Riverside Park",
  });
  return app.id;
}

const input = (s: SessionRow, appId: string, poppyApproval?: PoppyApproval): GuardInput => ({
  db,
  request: new Request("http://localhost:3100/api/applications/x/submit", {
    method: "POST",
    headers: { "user-agent": "PoppyTestAgent/1.0" },
  }),
  route: "api",
  userId: DEMO_USER_ID,
  session: s,
  action: "submit_application",
  resourceId: appId,
  body: { declaration: "on" },
  secret: SECRET,
  mode: "enforce",
  ttlSeconds: 600,
  poppyApproval,
});

const approval = (t: Ticket, revision = revisionFor(t)): PoppyApproval => ({
  operation_id: t.id,
  revision,
  approver: "user",
});

const gatedTicket = (g: GuardResult) => {
  expect(g.kind).toBe("gated");
  return (g as Extract<GuardResult, { kind: "gated" }>).ticket;
};

const ticketRow = async (id: string) =>
  (await db.select().from(hitlTickets).where(eq(hitlTickets.id, id)))[0];
const appStatus = async (id: string) =>
  (await db.select().from(applications).where(eq(applications.id, id)))[0].status;

describe("Poppy approvals", () => {
  it("T18: an approval before the passkey is declined and nothing runs", async () => {
    const s = await session();
    const app = await draft();
    const t = gatedTicket(await hitlGuard(input(s, app)));

    const declined = await hitlGuard(input(s, app, approval(t)));
    expect(declined.kind).toBe("approval_declined");
    expect((await ticketRow(t.id)).state).toBe("pending");
    expect(await appStatus(app)).toBe("draft");
    const reasons = (await db.select().from(requestLog).where(eq(requestLog.ticketId, t.id))).map(
      (r) => r.reason,
    );
    expect(reasons).toContain("poppy:agent_only_approval");

    // An agent approval is no different.
    const agent = await hitlGuard(input(s, app, { ...approval(t), approver: "agent" }));
    expect(agent.kind).toBe("approval_declined");
  });

  it("T17: after the passkey, the revision changes, then the approval runs exactly once", async () => {
    const s = await session();
    const app = await draft();
    const t = gatedTicket(await hitlGuard(input(s, app)));
    const pendingRevision = revisionFor(t);
    await approveTicket(db, t.id, { method: "passkey", meta: {} });

    // The approval names the replaced revision: the current operation comes back.
    const replaced = gatedTicket(await hitlGuard(input(s, app, approval(t, pendingRevision))));
    expect(replaced.id).toBe(t.id);
    const current = revisionFor(replaced);
    expect(current).not.toBe(pendingRevision);

    const g = await hitlGuard(input(s, app, approval(t, current)));
    expect(g.kind).toBe("ok");
    await submitApplication(db, DEMO_USER_ID, app);
    await (g as Extract<GuardResult, { kind: "ok" }>).finish("executed");
    expect((await ticketRow(t.id)).state).toBe("consumed");

    const again = await hitlGuard(input(s, app, approval(t, current)));
    expect(again).toMatchObject({ kind: "already_performed", status: "performed" });
  });

  it("a resend while the action is still running says so instead of running it again", async () => {
    const s = await session();
    const app = await draft();
    const t = gatedTicket(await hitlGuard(input(s, app)));
    await approveTicket(db, t.id, { method: "passkey", meta: {} });
    const approved = { ...t, state: "approved" as const };
    const first = await hitlGuard(input(s, app, approval(approved)));
    expect(first.kind).toBe("ok");
    // Not finished yet.
    const second = await hitlGuard(input(s, app, approval(approved)));
    expect(second).toMatchObject({ kind: "already_performed", status: "performing" });
  });

  it("another session's approval counts as no approval", async () => {
    const owner = await session();
    const other = await session();
    const app = await draft();
    const t = gatedTicket(await hitlGuard(input(owner, app)));
    await approveTicket(db, t.id, { method: "passkey", meta: {} });
    const g = gatedTicket(
      await hitlGuard(input(other, app, approval({ ...t, state: "approved" }))),
    );
    expect(g.id).not.toBe(t.id);
    expect((await ticketRow(t.id)).state).toBe("approved");
  });

  it("a changed request needs a new operation", async () => {
    const s = await session();
    const app = await draft();
    const t = gatedTicket(await hitlGuard(input(s, app)));
    await approveTicket(db, t.id, { method: "passkey", meta: {} });
    await updateDraft(db, DEMO_USER_ID, app, { attendance: "90" });
    const g = gatedTicket(await hitlGuard(input(s, app, approval({ ...t, state: "approved" }))));
    expect(g.id).not.toBe(t.id);
    expect(await appStatus(app)).toBe("draft");
  });
});
