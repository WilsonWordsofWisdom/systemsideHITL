// Ticket-bound approval challenges (controls W2, W3; J02 "assertion made for
// another ticket is rejected", T7 expiry during approval).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toBase64Url } from "@/lib/auth/webauthn";
import { createSession } from "@/lib/auth/session";
import { hitlTickets } from "@/lib/db/schema";
import type { AppDb } from "@/lib/db/types";
import {
  approvalChallengeBytes,
  approvalRefusal,
  checkApprovalChallenge,
  issueApprovalChallenge,
} from "@/lib/hitl/approval";
import { approveTicket, requestTicket, type Ticket } from "@/lib/hitl/tickets";
import { eq } from "drizzle-orm";
import { DEMO_USER_ID, SECOND_USER_ID } from "@/scripts/seed";
import { createTestDb } from "../helpers/db";

let db: AppDb;
let close: () => Promise<void>;
let requester: string;
let approverSession: string;
let otherSession: string;
const t0 = new Date("2026-12-01T09:00:00Z");
const at = (s: number) => new Date(t0.getTime() + s * 1000);
let n = 0;

beforeAll(async () => {
  ({ db, close } = await createTestDb({ seed: true }));
  requester = (await createSession(db, { userId: DEMO_USER_ID, signinMethod: "password" }, t0))
    .session.id;
  approverSession = (
    await createSession(
      db,
      { userId: DEMO_USER_ID, signinMethod: "passkey", approvalOnly: true },
      t0,
    )
  ).session.id;
  otherSession = (await createSession(db, { userId: DEMO_USER_ID, signinMethod: "password" }, t0))
    .session.id;
});
afterAll(async () => close());

async function ticket(hash = "hash-1"): Promise<Ticket> {
  const { ticket } = await requestTicket(
    db,
    {
      userId: DEMO_USER_ID,
      action: "submit_application",
      resourceId: `res-${++n}`,
      payloadHash: hash,
      preview: {},
      actor: { class: "suspected_agent" },
      sessionId: requester,
      ttlSeconds: 600,
    },
    t0,
  );
  return ticket;
}
const approver = () => ({ userId: DEMO_USER_ID, sessionId: approverSession });

describe("challenge derivation (W2)", () => {
  it("binds ticket, payload hash and nonce", () => {
    const a = toBase64Url(approvalChallengeBytes("hitl_a", "h1", "n1"));
    expect(toBase64Url(approvalChallengeBytes("hitl_a", "h1", "n1"))).toBe(a);
    expect(toBase64Url(approvalChallengeBytes("hitl_b", "h1", "n1"))).not.toBe(a);
    expect(toBase64Url(approvalChallengeBytes("hitl_a", "h2", "n1"))).not.toBe(a);
    expect(toBase64Url(approvalChallengeBytes("hitl_a", "h1", "n2"))).not.toBe(a);
  });
});

describe("issuing and checking a challenge", () => {
  it("accepts the challenge once for the ticket and session it was issued to", async () => {
    const t = await ticket();
    const { challengeId, bytes } = await issueApprovalChallenge(db, t, approver(), at(5));
    const ok = await checkApprovalChallenge(db, challengeId, t, approver(), at(6));
    expect(ok).toEqual({ ok: true, expectedChallenge: toBase64Url(bytes) });
    // Single use: a replay of the same challenge is refused.
    expect(await checkApprovalChallenge(db, challengeId, t, approver(), at(7))).toEqual({
      ok: false,
      reason: "bad_challenge",
    });
  });

  it("refuses a challenge issued for another ticket", async () => {
    const a = await ticket();
    const b = await ticket();
    const { challengeId } = await issueApprovalChallenge(db, a, approver(), at(5));
    expect(await checkApprovalChallenge(db, challengeId, b, approver(), at(6))).toEqual({
      ok: false,
      reason: "challenge_mismatch",
    });
  });

  it("refuses a challenge used from another session", async () => {
    const t = await ticket();
    const { challengeId } = await issueApprovalChallenge(db, t, approver(), at(5));
    const other = { userId: DEMO_USER_ID, sessionId: otherSession };
    expect((await checkApprovalChallenge(db, challengeId, t, other, at(6))).ok).toBe(false);
  });

  it("refuses when the ticket's payload hash changed after the challenge was issued", async () => {
    const t = await ticket();
    const { challengeId } = await issueApprovalChallenge(db, t, approver(), at(5));
    const changed = { ...t, payloadHash: "hash-edited" };
    expect(await checkApprovalChallenge(db, challengeId, changed, approver(), at(6))).toEqual({
      ok: false,
      reason: "challenge_mismatch",
    });
  });

  it("refuses an unknown or expired challenge", async () => {
    const t = await ticket();
    expect((await checkApprovalChallenge(db, "nope", t, approver(), at(6))).ok).toBe(false);
    const { challengeId } = await issueApprovalChallenge(db, t, approver(), at(5));
    expect((await checkApprovalChallenge(db, challengeId, t, approver(), at(5 + 301))).ok).toBe(
      false,
    );
  });
});

describe("who may approve (W3, T7)", () => {
  it("only the ticket's user, only while pending and unexpired", async () => {
    const t = await ticket();
    expect(approvalRefusal(t, DEMO_USER_ID, at(10))).toBeNull();
    expect(approvalRefusal(t, SECOND_USER_ID, at(10))).toBe("wrong_account");
    expect(approvalRefusal(t, DEMO_USER_ID, at(600))).toBe("not_pending");
    await approveTicket(db, t.id, { method: "passkey", meta: {} }, at(20));
    const [approved] = await db.select().from(hitlTickets).where(eq(hitlTickets.id, t.id));
    expect(approvalRefusal(approved, DEMO_USER_ID, at(21))).toBe("not_pending");
  });
});
