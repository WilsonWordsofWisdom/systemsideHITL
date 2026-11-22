// WebAuthn helpers shared by passkey enrolment, passkey sign-in and (Phase 2)
// ticket approval. Database-facing functions take `now` for testability.
import { and, eq, gt, isNull, lt } from "drizzle-orm";
import { webauthnChallenges } from "../db/schema";
import type { AppDb } from "../db/types";
import { randomToken } from "./crypto";

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
// Enrolling a passkey needs a sign-in within the last 10 minutes (control W7).
export const FRESH_SIGNIN_MS = 10 * 60 * 1000;
export const RP_NAME = "DemoGov Permits";

export type ChallengePurpose = "register" | "login" | "approve";

export async function issueChallenge(
  db: AppDb,
  input: { purpose: ChallengePurpose; challenge: string; userId?: string; sessionId?: string },
  now = new Date(),
) {
  // Housekeeping: drop challenges that expired over an hour ago.
  await db
    .delete(webauthnChallenges)
    .where(lt(webauthnChallenges.expiresAt, new Date(now.getTime() - 60 * 60 * 1000)));
  const id = randomToken(24);
  await db.insert(webauthnChallenges).values({
    id,
    purpose: input.purpose,
    challenge: input.challenge,
    userId: input.userId ?? null,
    sessionId: input.sessionId ?? null,
    createdAt: now,
    expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS),
  });
  return id;
}

// Marks a challenge used and returns it, atomically; null if unknown, expired,
// already used or issued for a different purpose.
export async function consumeChallenge(
  db: AppDb,
  id: string,
  purpose: ChallengePurpose,
  now = new Date(),
) {
  const [row] = await db
    .update(webauthnChallenges)
    .set({ usedAt: now })
    .where(
      and(
        eq(webauthnChallenges.id, id),
        eq(webauthnChallenges.purpose, purpose),
        isNull(webauthnChallenges.usedAt),
        gt(webauthnChallenges.expiresAt, now),
      ),
    )
    .returning();
  return row ?? null;
}

export type EnrolmentCheck =
  { ok: true } | { ok: false; reason: "enrolment_closed" | "signin_not_fresh" | "approval_only" };

export function enrolmentAllowed(input: {
  open: boolean;
  session: { createdAt: Date; approvalOnly: boolean };
  now?: Date;
}): EnrolmentCheck {
  const now = input.now ?? new Date();
  if (!input.open) return { ok: false, reason: "enrolment_closed" };
  if (input.session.approvalOnly) return { ok: false, reason: "approval_only" };
  if (now.getTime() - input.session.createdAt.getTime() > FRESH_SIGNIN_MS) {
    return { ok: false, reason: "signin_not_fresh" };
  }
  return { ok: true };
}

export const toBase64Url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
export const fromBase64Url = (text: string) => new Uint8Array(Buffer.from(text, "base64url"));
