// Ticket approval with a passkey (spec 9.3, FR20, controls W1-W4, T9).
// The WebAuthn challenge is bound to the ticket: H(ticketId | payload_hash | nonce),
// with a single-use nonce stored server-side and the expected value recomputed
// from the ticket row at verify time (W2). An assertion made for one ticket can't
// approve another, and a payload change after the challenge was issued fails too.
import { createHash } from "node:crypto";
import { randomToken } from "../auth/crypto";
import { consumeChallenge, issueChallenge, toBase64Url } from "../auth/webauthn";
import type { AppDb } from "../db/types";
import type { LimitRule } from "../ratelimit";
import type { Ticket } from "./tickets";

// Failed approval attempts (control T9): per user and per IP hash.
export const APPROVE_USER_LIMIT: LimitRule = { max: 10, windowSec: 60, lockSec: 300 };
export const APPROVE_IP_LIMIT: LimitRule = { max: 30, windowSec: 60, lockSec: 300 };

export function approvalChallengeBytes(ticketId: string, payloadHash: string, nonce: string) {
  return new Uint8Array(
    createHash("sha256").update(`${ticketId}|${payloadHash}|${nonce}`).digest(),
  );
}

export type ApprovalRefusal =
  "wrong_account" | "not_pending" | "bad_challenge" | "challenge_mismatch";

// Who may approve: the ticket's own user, on a pending, unexpired ticket (W3, T3).
export function approvalRefusal(
  ticket: Ticket,
  approverUserId: string,
  now = new Date(),
): ApprovalRefusal | null {
  if (ticket.userId !== approverUserId) return "wrong_account";
  if (ticket.state !== "pending" || ticket.expiresAt <= now) return "not_pending";
  return null;
}

// Issues the ticket-bound challenge. Returns the raw bytes for the WebAuthn options.
export async function issueApprovalChallenge(
  db: AppDb,
  ticket: Ticket,
  approver: { userId: string; sessionId: string },
  now = new Date(),
) {
  const nonce = randomToken(16);
  const bytes = approvalChallengeBytes(ticket.id, ticket.payloadHash, nonce);
  const challengeId = await issueChallenge(
    db,
    {
      purpose: "approve",
      challenge: toBase64Url(bytes),
      userId: approver.userId,
      sessionId: approver.sessionId,
      ticketId: ticket.id,
      nonce,
    },
    now,
  );
  return { challengeId, bytes };
}

// Consumes the challenge and checks every binding. On success returns the
// expected challenge (base64url) to verify the assertion against.
export async function checkApprovalChallenge(
  db: AppDb,
  challengeId: string,
  ticket: Ticket,
  approver: { userId: string; sessionId: string },
  now = new Date(),
): Promise<{ ok: true; expectedChallenge: string } | { ok: false; reason: ApprovalRefusal }> {
  const row = await consumeChallenge(db, challengeId, "approve", now);
  if (!row || !row.nonce) return { ok: false, reason: "bad_challenge" };
  if (
    row.ticketId !== ticket.id ||
    row.userId !== ticket.userId ||
    row.userId !== approver.userId ||
    row.sessionId !== approver.sessionId
  ) {
    return { ok: false, reason: "challenge_mismatch" };
  }
  const expected = toBase64Url(approvalChallengeBytes(ticket.id, ticket.payloadHash, row.nonce));
  if (expected !== row.challenge) return { ok: false, reason: "challenge_mismatch" };
  return { ok: true, expectedChallenge: expected };
}
