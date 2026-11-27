// One-time passkey enrolment codes and the combined enrolment check (gap H1,
// control W12).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ENROLMENT_CODE_LIMIT,
  ENROLMENT_CODE_TTL_MS,
  checkEnrolment,
  checkEnrolmentCode,
  consumeEnrolmentCode,
  issueEnrolmentCode,
  normaliseCode,
} from "@/lib/auth/enrolment-codes";
import { passkeyEnrolmentCodes, passkeys, rateLimits } from "@/lib/db/schema";
import type { AppDb } from "@/lib/db/types";
import { DEMO_USER_ID, SECOND_USER_ID } from "@/scripts/seed";
import { createTestDb } from "../helpers/db";

let db: AppDb;
let close: () => Promise<void>;
const t0 = new Date("2026-12-01T09:00:00Z");
const at = (ms: number) => new Date(t0.getTime() + ms);
const passwordSession = { createdAt: t0, approvalOnly: false, signinMethod: "password" };

beforeAll(async () => {
  ({ db, close } = await createTestDb({ seed: true }));
});
afterAll(async () => close());
beforeEach(async () => {
  await db.delete(passkeyEnrolmentCodes);
  await db.delete(passkeys);
  await db.delete(rateLimits);
});

describe("enrolment codes", () => {
  it("are 12 readable characters in three groups, and normalise for entry", async () => {
    const { code, expiresAt } = await issueEnrolmentCode(db, DEMO_USER_ID, t0);
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(expiresAt.getTime() - t0.getTime()).toBe(ENROLMENT_CODE_TTL_MS);
    expect(normaliseCode(` ${code.toLowerCase().replace(/-/g, " ")} `)).toBe(
      code.replace(/-/g, ""),
    );
    expect(normaliseCode("too-short")).toBeNull();
    expect(normaliseCode("IIII-LLLL-OOOO")).toBeNull();
  });

  it("are stored only as a hash", async () => {
    const { code } = await issueEnrolmentCode(db, DEMO_USER_ID, t0);
    const rows = await db.select().from(passkeyEnrolmentCodes);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(code.replace(/-/g, ""));
  });

  it("work once, for their own account, before they expire", async () => {
    const { code } = await issueEnrolmentCode(db, DEMO_USER_ID, t0);
    expect(await checkEnrolmentCode(db, SECOND_USER_ID, code, at(1000))).toBeNull();
    expect(await checkEnrolmentCode(db, DEMO_USER_ID, code, at(ENROLMENT_CODE_TTL_MS))).toBeNull();
    const id = await checkEnrolmentCode(db, DEMO_USER_ID, code, at(1000));
    expect(id).not.toBeNull();
    expect(await consumeEnrolmentCode(db, id!, DEMO_USER_ID, at(2000))).toBe(true);
    expect(await consumeEnrolmentCode(db, id!, DEMO_USER_ID, at(3000))).toBe(false);
    expect(await checkEnrolmentCode(db, DEMO_USER_ID, code, at(3000))).toBeNull();
  });

  it("replace an earlier unused code for the same account", async () => {
    const first = await issueEnrolmentCode(db, DEMO_USER_ID, t0);
    const second = await issueEnrolmentCode(db, DEMO_USER_ID, at(1000));
    expect(await checkEnrolmentCode(db, DEMO_USER_ID, first.code, at(2000))).toBeNull();
    expect(await checkEnrolmentCode(db, DEMO_USER_ID, second.code, at(2000))).not.toBeNull();
  });
});

describe("checkEnrolment", () => {
  const input = { open: true, session: passwordSession, userId: DEMO_USER_ID };

  it("refuses a password session with no code (H1: the password alone adds nothing)", async () => {
    expect(await checkEnrolment(db, { ...input, code: "" }, at(1000))).toMatchObject({
      ok: false,
      reason: "code_required",
    });
  });

  it("accepts a valid code and returns its ID for the challenge", async () => {
    const { code } = await issueEnrolmentCode(db, DEMO_USER_ID, t0);
    const result = await checkEnrolment(db, { ...input, code }, at(1000));
    expect(result).toMatchObject({ ok: true, via: "code" });
    expect(result.ok && result.codeId).toBeTruthy();
  });

  it("checks a supplied code even after a passkey sign-in", async () => {
    await db.insert(passkeys).values({
      userId: DEMO_USER_ID,
      credentialId: "cred-1",
      publicKey: "pk",
      counter: 0,
      transports: [],
    });
    const passkeySession = { ...passwordSession, signinMethod: "passkey" };
    expect(
      await checkEnrolment(db, { ...input, session: passkeySession, code: null }, at(1000)),
    ).toMatchObject({ ok: true, via: "passkey", codeId: null });
    expect(
      await checkEnrolment(
        db,
        { ...input, session: passkeySession, code: "AAAA-AAAA-AAAA" },
        at(1000),
      ),
    ).toMatchObject({ ok: false, reason: "code_invalid" });
  });

  it("locks code entry after repeated wrong codes, and doesn't count other refusals", async () => {
    expect(
      await checkEnrolment(db, { ...input, open: false, code: "AAAA-AAAA-AAAA" }, at(0)),
    ).toMatchObject({ ok: false, reason: "enrolment_closed" });
    for (let i = 0; i < ENROLMENT_CODE_LIMIT.max; i++) {
      expect(
        await checkEnrolment(db, { ...input, code: "AAAA-AAAA-AAAA" }, at(1000 + i)),
      ).toMatchObject({ ok: false, reason: "code_invalid" });
    }
    const { code } = await issueEnrolmentCode(db, DEMO_USER_ID, at(2000));
    expect(await checkEnrolment(db, { ...input, code }, at(3000))).toMatchObject({
      ok: false,
      reason: "code_locked",
      status: 429,
    });
  });
});
