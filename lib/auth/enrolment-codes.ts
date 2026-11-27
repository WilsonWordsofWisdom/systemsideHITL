// One-time passkey enrolment codes (gap H1, control W12). The console admin
// issues a code for one account and gives it to the person out of band; enrolling
// a first passkey, or one without a passkey sign-in, needs it. An agent that only
// has the password therefore can't enrol a passkey of its own and approve with it.
import { randomInt } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { passkeyEnrolmentCodes, passkeys } from "../db/schema";
import type { AppDb } from "../db/types";
import { lockedUntil, recordFailure, retryAfter, type LimitRule } from "../ratelimit";
import { sha256Hex } from "./crypto";
import { enrolmentAllowed, type EnrolmentRefusal } from "./webauthn";

export const ENROLMENT_CODE_TTL_MS = 15 * 60 * 1000;
// Wrong codes per account: 5 in 10 minutes locks code entry for 10 minutes.
export const ENROLMENT_CODE_LIMIT: LimitRule = { max: 5, windowSec: 600, lockSec: 600 };

// Crockford base32 without I, L, O and U, so the code is easy to read out and type.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const GROUPS = 3;
const GROUP_LENGTH = 4; // 12 characters, 60 bits.

// Upper case, without spaces or hyphens; null when it can't be a code.
export function normaliseCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const code = input.replace(/[\s-]/g, "").toUpperCase();
  const expected = GROUPS * GROUP_LENGTH;
  if (code.length !== expected || [...code].some((c) => !ALPHABET.includes(c))) return null;
  return code;
}

export const codeId = (normalised: string) => sha256Hex(`enrol:${normalised}`);

// Issues a code for the user, replacing any unused one. Returns it for display once.
export async function issueEnrolmentCode(db: AppDb, userId: string, now = new Date()) {
  const raw = Array.from({ length: GROUPS * GROUP_LENGTH }, () => ALPHABET[randomInt(32)]).join("");
  await db
    .delete(passkeyEnrolmentCodes)
    .where(and(eq(passkeyEnrolmentCodes.userId, userId), isNull(passkeyEnrolmentCodes.usedAt)));
  const expiresAt = new Date(now.getTime() + ENROLMENT_CODE_TTL_MS);
  await db
    .insert(passkeyEnrolmentCodes)
    .values({ id: codeId(raw), userId, createdAt: now, expiresAt });
  const display = raw.match(new RegExp(`.{${GROUP_LENGTH}}`, "g"))!.join("-");
  return { code: display, expiresAt };
}

const usable = (id: string, userId: string, now: Date) =>
  and(
    eq(passkeyEnrolmentCodes.id, id),
    eq(passkeyEnrolmentCodes.userId, userId),
    isNull(passkeyEnrolmentCodes.usedAt),
    gt(passkeyEnrolmentCodes.expiresAt, now),
  );

// The code's ID when it is valid for this user now, without using it up.
export async function checkEnrolmentCode(
  db: AppDb,
  userId: string,
  input: unknown,
  now = new Date(),
) {
  const code = normaliseCode(input);
  if (!code) return null;
  const id = codeId(code);
  const [row] = await db
    .select({ id: passkeyEnrolmentCodes.id })
    .from(passkeyEnrolmentCodes)
    .where(usable(id, userId, now))
    .limit(1);
  return row?.id ?? null;
}

export type EnrolmentDecision =
  | { ok: true; via: "code" | "passkey"; codeId: string | null }
  | {
      ok: false;
      reason: EnrolmentRefusal | "code_invalid" | "code_locked";
      status: number;
      retryAfter?: string;
    };

// The whole enrolment check for the options and verify routes: the rule in
// enrolmentAllowed, plus checking a supplied code, with wrong codes rate limited.
// A supplied code is always checked, never ignored in favour of a passkey sign-in.
export async function checkEnrolment(
  db: AppDb,
  input: {
    open: boolean;
    session: { createdAt: Date; approvalOnly: boolean; signinMethod: string };
    userId: string;
    code: unknown;
  },
  now = new Date(),
): Promise<EnrolmentDecision> {
  const [existing] = await db
    .select({ id: passkeys.id })
    .from(passkeys)
    .where(eq(passkeys.userId, input.userId))
    .limit(1);
  const rule = { open: input.open, session: input.session, hasPasskeys: !!existing, now };
  const base = enrolmentAllowed({ ...rule, validCode: false });
  const provided = typeof input.code === "string" && input.code.trim() !== "";
  if (!base.ok && !["code_required", "passkey_signin_required"].includes(base.reason)) {
    return { ok: false, reason: base.reason, status: 403 };
  }
  if (!provided) {
    return base.ok
      ? { ok: true, via: base.via, codeId: null }
      : { ok: false, reason: base.reason, status: 403 };
  }

  const key = `enrol_code:user:${input.userId}`;
  const until = await lockedUntil(db, key, now);
  if (until) {
    return {
      ok: false,
      reason: "code_locked",
      status: 429,
      retryAfter: retryAfter(until, now, ENROLMENT_CODE_LIMIT.lockSec),
    };
  }
  const id = await checkEnrolmentCode(db, input.userId, input.code, now);
  if (!id) {
    await recordFailure(db, key, ENROLMENT_CODE_LIMIT, now);
    return { ok: false, reason: "code_invalid", status: 400 };
  }
  const withCode = enrolmentAllowed({ ...rule, validCode: true });
  return withCode.ok
    ? { ok: true, via: withCode.via, codeId: id }
    : { ok: false, reason: withCode.reason, status: 403 };
}

// Uses the code up, atomically. False when it was used, expired or not this user's.
export async function consumeEnrolmentCode(
  db: AppDb,
  id: string,
  userId: string,
  now = new Date(),
) {
  const rows = await db
    .update(passkeyEnrolmentCodes)
    .set({ usedAt: now })
    .where(usable(id, userId, now))
    .returning({ id: passkeyEnrolmentCodes.id });
  return rows.length === 1;
}
