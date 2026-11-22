// WebAuthn challenge store (controls W1, W2) and enrolment rules (FR7, control W7).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CHALLENGE_TTL_MS,
  FRESH_SIGNIN_MS,
  consumeChallenge,
  enrolmentAllowed,
  fromBase64Url,
  issueChallenge,
  toBase64Url,
} from "@/lib/auth/webauthn";
import type { AppDb } from "@/lib/db/types";
import { DEMO_USER_ID } from "@/scripts/seed";
import { createTestDb } from "../helpers/db";

let db: AppDb;
let close: () => Promise<void>;
const t0 = new Date("2026-12-01T09:00:00Z");
const at = (ms: number) => new Date(t0.getTime() + ms);

beforeAll(async () => {
  ({ db, close } = await createTestDb({ seed: true }));
});
afterAll(async () => close());

describe("challenges", () => {
  it("can be used once", async () => {
    const id = await issueChallenge(db, { purpose: "login", challenge: "c1" }, t0);
    expect((await consumeChallenge(db, id, "login", at(1000)))?.challenge).toBe("c1");
    expect(await consumeChallenge(db, id, "login", at(2000))).toBeNull();
  });

  it("expire after 5 minutes", async () => {
    const id = await issueChallenge(db, { purpose: "login", challenge: "c2" }, t0);
    expect(await consumeChallenge(db, id, "login", at(CHALLENGE_TTL_MS + 1))).toBeNull();
  });

  it("only match their own purpose", async () => {
    const id = await issueChallenge(
      db,
      { purpose: "register", challenge: "c3", userId: DEMO_USER_ID, sessionId: "s1" },
      t0,
    );
    expect(await consumeChallenge(db, id, "login", at(1000))).toBeNull();
    const row = await consumeChallenge(db, id, "register", at(1000));
    expect(row).toMatchObject({ challenge: "c3", userId: DEMO_USER_ID, sessionId: "s1" });
  });

  it("reject unknown IDs", async () => {
    expect(await consumeChallenge(db, "no-such-id", "login", t0)).toBeNull();
  });
});

describe("enrolmentAllowed", () => {
  const session = { createdAt: t0, approvalOnly: false };
  it("allows a fresh sign-in while enrolment is open", () => {
    expect(enrolmentAllowed({ open: true, session, now: at(60_000) })).toEqual({ ok: true });
  });
  it("refuses while enrolment is closed (J12)", () => {
    expect(enrolmentAllowed({ open: false, session, now: at(60_000) })).toEqual({
      ok: false,
      reason: "enrolment_closed",
    });
  });
  it("refuses when the sign-in is not fresh", () => {
    expect(enrolmentAllowed({ open: true, session, now: at(FRESH_SIGNIN_MS + 1) })).toEqual({
      ok: false,
      reason: "signin_not_fresh",
    });
  });
  it("refuses approval-only sessions", () => {
    expect(
      enrolmentAllowed({ open: true, session: { ...session, approvalOnly: true }, now: t0 }),
    ).toEqual({ ok: false, reason: "approval_only" });
  });
});

describe("base64url", () => {
  it("round-trips public keys", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255]);
    expect(Array.from(fromBase64Url(toBase64Url(bytes)))).toEqual(Array.from(bytes));
  });
});
