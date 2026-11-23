// The phone page's queries (FR20, FR22, J05): only the account holder's own pending,
// unexpired requests, newest first, and recent decisions as confirmations.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSession } from "@/lib/auth/session";
import type { AppDb } from "@/lib/db/types";
import { pendingIds, pendingTickets, recentDecisions } from "@/lib/hitl/device";
import { approveTicket, rejectTicket, requestTicket, type TicketRequest } from "@/lib/hitl/tickets";
import { DEMO_USER_ID, SECOND_USER_ID } from "@/scripts/seed";
import { createTestDb } from "../helpers/db";

let db: AppDb;
let close: () => Promise<void>;
const t0 = new Date("2026-12-01T09:00:00Z");
const at = (s: number) => new Date(t0.getTime() + s * 1000);

beforeAll(async () => {
  ({ db, close } = await createTestDb({ seed: true }));
});
afterAll(async () => close());

async function ticket(userId: string, resourceId: string, when: Date, ttlSeconds = 600) {
  const { session } = await createSession(db, { userId, signinMethod: "password" }, when);
  const r: TicketRequest = {
    userId,
    action: "submit_application",
    resourceId,
    payloadHash: `hash-${resourceId}`,
    preview: { summary: `Submit ${resourceId}` },
    actor: { class: "suspected_agent" },
    sessionId: session.id,
    ttlSeconds,
  };
  return (await requestTicket(db, r, when)).ticket;
}

describe("phone page", () => {
  it("lists only the account holder's pending, unexpired requests, newest first", async () => {
    const older = await ticket(DEMO_USER_ID, "app-1", t0);
    const newer = await ticket(DEMO_USER_ID, "app-2", at(10));
    await ticket(DEMO_USER_ID, "app-3", t0, 30); // expires at 30 s
    const other = await ticket(SECOND_USER_ID, "app-4", at(10));

    expect(await pendingIds(db, DEMO_USER_ID, at(60))).toEqual([newer.id, older.id]);
    expect(await pendingIds(db, SECOND_USER_ID, at(60))).toEqual([other.id]);

    await approveTicket(db, newer.id, { method: "passkey", meta: {} }, at(70));
    await rejectTicket(db, older.id, "declined", at(80));
    expect(await pendingTickets(db, DEMO_USER_ID, at(90))).toEqual([]);
    const decided = await recentDecisions(db, DEMO_USER_ID, at(90));
    expect(decided.map((t) => [t.id, t.state])).toEqual([
      [older.id, "rejected"],
      [newer.id, "approved"],
    ]);
    // Confirmations last 10 minutes.
    expect(await recentDecisions(db, DEMO_USER_ID, at(80 + 601))).toEqual([]);
  });
});
