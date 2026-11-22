// Sign-in lockout: J01 "Wrong password is rejected and repeated failures are rate limited".
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppDb } from "@/lib/db/types";
import { LOGIN_EMAIL_LIMIT, clearFailures, lockedUntil, recordFailure } from "@/lib/ratelimit";
import { createTestDb } from "../helpers/db";

let db: AppDb;
let close: () => Promise<void>;
const t0 = new Date("2026-12-01T09:00:00Z");
const at = (s: number) => new Date(t0.getTime() + s * 1000);

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());

describe("login rate limit", () => {
  it("locks after 5 failures within a minute, for 10 minutes", async () => {
    const key = "login:email:a@demogov.test";
    for (let i = 0; i < 4; i++) {
      expect(await recordFailure(db, key, LOGIN_EMAIL_LIMIT, at(i * 5))).toBe(false);
      expect(await lockedUntil(db, key, at(i * 5))).toBeNull();
    }
    expect(await recordFailure(db, key, LOGIN_EMAIL_LIMIT, at(25))).toBe(true);
    expect(await lockedUntil(db, key, at(26))).not.toBeNull();
    expect(await lockedUntil(db, key, at(25 + 599))).not.toBeNull();
    expect(await lockedUntil(db, key, at(25 + 601))).toBeNull();
  });

  it("starts a new window when failures are spread out", async () => {
    const key = "login:email:b@demogov.test";
    for (let i = 0; i < 10; i++) {
      // One failure every 70 s: never 5 inside one 60 s window.
      const locked = await recordFailure(db, key, LOGIN_EMAIL_LIMIT, at(i * 70));
      expect(locked).toBe(false);
    }
  });

  it("clears the counter after a successful sign-in", async () => {
    const key = "login:email:c@demogov.test";
    for (let i = 0; i < 4; i++) await recordFailure(db, key, LOGIN_EMAIL_LIMIT, at(i));
    await clearFailures(db, key);
    expect(await recordFailure(db, key, LOGIN_EMAIL_LIMIT, at(5))).toBe(false);
  });
});
