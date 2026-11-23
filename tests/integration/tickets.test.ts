// Ticket service: state machine, reuse/supersede, redemption binding and atomic
// consume (controls T2-T6, FR18, FR19; J02 tamper/replay/expiry/wrong-session).
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSession } from "@/lib/auth/session";
import { hitlTickets } from "@/lib/db/schema";
import type { AppDb } from "@/lib/db/types";
import {
  TICKET_ID_PATTERN,
  approveTicket,
  getTicket,
  newTicketId,
  redeemTicket,
  rejectTicket,
  requestTicket,
  type TicketRequest,
} from "@/lib/hitl/tickets";
import { DEMO_USER_ID, SECOND_USER_ID } from "@/scripts/seed";
import { createTestDb } from "../helpers/db";

let db: AppDb;
let close: () => Promise<void>;
let sessionA: string;
let sessionB: string;
let secondUserSession: string;
const t0 = new Date("2026-12-01T09:00:00Z");
const at = (s: number) => new Date(t0.getTime() + s * 1000);
let n = 0;

beforeAll(async () => {
  ({ db, close } = await createTestDb({ seed: true }));
  sessionA = (await createSession(db, { userId: DEMO_USER_ID, signinMethod: "password" }, t0))
    .session.id;
  sessionB = (await createSession(db, { userId: DEMO_USER_ID, signinMethod: "password" }, t0))
    .session.id;
  secondUserSession = (
    await createSession(db, { userId: SECOND_USER_ID, signinMethod: "password" }, t0)
  ).session.id;
});
afterAll(async () => close());

// Each test uses its own resource so pending tickets don't interact.
function req(over: Partial<TicketRequest> = {}): TicketRequest {
  return {
    userId: DEMO_USER_ID,
    action: "submit_application",
    resourceId: `res-${++n}`,
    payloadHash: "hash-1",
    preview: { summary: "Submit" },
    actor: { class: "unknown" },
    sessionId: sessionA,
    ttlSeconds: 600,
    ...over,
  };
}
const redemption = (r: TicketRequest, over: object = {}) => ({
  userId: r.userId,
  action: r.action,
  resourceId: r.resourceId,
  payloadHash: r.payloadHash,
  sessionId: r.sessionId,
  ...over,
});
const approve = (id: string, when = at(10)) =>
  approveTicket(db, id, { method: "passkey", meta: {} }, when);

describe("ticket IDs (T4)", () => {
  it("are hitl_ plus 256 random bits", () => {
    const ids = new Set(Array.from({ length: 50 }, newTicketId));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(TICKET_ID_PATTERN);
  });
});

describe("requesting tickets", () => {
  it("creates a pending ticket bound to user, action, resource, hash and session", async () => {
    const r = req();
    const { ticket, reused } = await requestTicket(db, r, t0);
    expect(reused).toBe(false);
    expect(ticket).toMatchObject({
      state: "pending",
      userId: DEMO_USER_ID,
      action: r.action,
      resourceId: r.resourceId,
      payloadHash: "hash-1",
      requestingSessionId: sessionA,
    });
    expect(ticket.expiresAt.getTime() - t0.getTime()).toBe(600_000);
  });

  it("returns the same pending ticket for an identical repeat", async () => {
    const r = req();
    const first = await requestTicket(db, r, t0);
    const again = await requestTicket(db, r, at(5));
    expect(again.reused).toBe(true);
    expect(again.ticket.id).toBe(first.ticket.id);
    const rows = await db
      .select()
      .from(hitlTickets)
      .where(eq(hitlTickets.resourceId, r.resourceId!));
    expect(rows).toHaveLength(1);
  });

  it("supersedes the pending ticket when the payload changes", async () => {
    const r = req();
    const first = await requestTicket(db, r, t0);
    const changed = await requestTicket(db, { ...r, payloadHash: "hash-2" }, at(5));
    expect(changed.reused).toBe(false);
    expect(changed.superseded).toEqual([first.ticket.id]);
    const old = await getTicket(db, first.ticket.id, at(6));
    expect(old).toMatchObject({ state: "rejected", rejectReason: "superseded" });
  });

  it("does not reuse another session's pending ticket", async () => {
    const r = req();
    const first = await requestTicket(db, r, t0);
    const other = await requestTicket(db, { ...r, sessionId: sessionB }, at(1));
    expect(other.ticket.id).not.toBe(first.ticket.id);
    expect((await getTicket(db, first.ticket.id, at(2)))?.state).toBe("pending");
  });
});

describe("state machine (T5)", () => {
  it("allows pending -> approved -> consumed only", async () => {
    const r = req();
    const { ticket } = await requestTicket(db, r, t0);
    expect((await approve(ticket.id))?.state).toBe("approved");
    expect(await approve(ticket.id)).toBeNull(); // approved -> approved
    expect(await rejectTicket(db, ticket.id, "declined", at(11))).toBeNull(); // approved -> rejected
    expect((await redeemTicket(db, ticket.id, redemption(r), at(12))).ok).toBe(true);
    expect(await approve(ticket.id, at(13))).toBeNull(); // consumed -> approved
    expect((await getTicket(db, ticket.id, at(14)))?.state).toBe("consumed");
  });

  it("allows pending -> rejected, and a rejected ticket can't be approved", async () => {
    const { ticket } = await requestTicket(db, req(), t0);
    expect((await rejectTicket(db, ticket.id, "declined", at(5)))?.state).toBe("rejected");
    expect(await approve(ticket.id)).toBeNull();
  });

  it("expires at read time after the TTL and can't then be approved (T3, T7)", async () => {
    const { ticket } = await requestTicket(db, req(), t0);
    expect(await approve(ticket.id, at(601))).toBeNull();
    expect((await getTicket(db, ticket.id, at(601)))?.state).toBe("expired");
    expect(await approve(ticket.id, at(602))).toBeNull();
  });

  it("rejects malformed IDs without a query", async () => {
    expect(await getTicket(db, "hitl_short")).toBeUndefined();
    expect(await getTicket(db, "' or 1=1 --")).toBeUndefined();
  });
});

describe("redemption", () => {
  it("rejects a made-up ID as not_found", async () => {
    const r = req();
    expect(await redeemTicket(db, newTicketId(), redemption(r), t0)).toMatchObject({
      ok: false,
      reason: "not_found",
    });
  });

  it("rejects a pending ticket as not_approved", async () => {
    const r = req();
    const { ticket } = await requestTicket(db, r, t0);
    expect(await redeemTicket(db, ticket.id, redemption(r), at(5))).toMatchObject({
      reason: "not_approved",
    });
  });

  it("rejects another session of the same user as wrong_session (FR19)", async () => {
    const r = req();
    const { ticket } = await requestTicket(db, r, t0);
    await approve(ticket.id);
    const res = await redeemTicket(db, ticket.id, redemption(r, { sessionId: sessionB }), at(20));
    expect(res).toMatchObject({ ok: false, reason: "wrong_session" });
    expect((await getTicket(db, ticket.id, at(21)))?.state).toBe("approved");
  });

  it("rejects another user's ticket as wrong_session", async () => {
    const r = req({ userId: SECOND_USER_ID, sessionId: secondUserSession });
    const { ticket } = await requestTicket(db, r, t0);
    await approve(ticket.id);
    const res = await redeemTicket(
      db,
      ticket.id,
      redemption(r, { userId: DEMO_USER_ID, sessionId: sessionA }),
      at(20),
    );
    expect(res).toMatchObject({ reason: "wrong_session" });
  });

  it("rejects a changed payload, action or resource as payload_mismatch (T5)", async () => {
    const r = req();
    const { ticket } = await requestTicket(db, r, t0);
    await approve(ticket.id);
    for (const over of [
      { payloadHash: "hash-other" },
      { action: "pay_fee" },
      { resourceId: "res-x" },
    ]) {
      expect(await redeemTicket(db, ticket.id, redemption(r, over), at(20))).toMatchObject({
        reason: "payload_mismatch",
      });
    }
    expect((await getTicket(db, ticket.id, at(21)))?.state).toBe("approved");
  });

  it("rejects a declined ticket as rejected", async () => {
    const r = req();
    const { ticket } = await requestTicket(db, r, t0);
    await rejectTicket(db, ticket.id, "declined", at(5));
    expect(await redeemTicket(db, ticket.id, redemption(r), at(6))).toMatchObject({
      reason: "rejected",
    });
  });

  it("rejects an approved ticket after expiry as expired", async () => {
    const r = req();
    const { ticket } = await requestTicket(db, r, t0);
    await approve(ticket.id);
    expect(await redeemTicket(db, ticket.id, redemption(r), at(600))).toMatchObject({
      reason: "expired",
    });
  });

  it("consumes exactly once; a replay is rejected as consumed (T6)", async () => {
    const r = req();
    const { ticket } = await requestTicket(db, r, t0);
    await approve(ticket.id);
    expect((await redeemTicket(db, ticket.id, redemption(r), at(20))).ok).toBe(true);
    expect(await redeemTicket(db, ticket.id, redemption(r), at(21))).toMatchObject({
      reason: "consumed",
    });
  });

  it("10 concurrent retries: exactly one wins, the rest are consumed (T2)", async () => {
    const r = req();
    const { ticket } = await requestTicket(db, r, t0);
    await approve(ticket.id);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => redeemTicket(db, ticket.id, redemption(r), at(30))),
    );
    expect(results.filter((x) => x.ok)).toHaveLength(1);
    const failures = results.filter((x) => !x.ok);
    expect(failures).toHaveLength(9);
    for (const f of failures) expect(f).toMatchObject({ reason: "consumed" });
  });
});
