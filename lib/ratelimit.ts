// Failure counting and lockout kept in Postgres (controls S3, T9).
import { eq, sql } from "drizzle-orm";
import { rateLimits } from "./db/schema";
import type { AppDb } from "./db/types";

export interface LimitRule {
  max: number;
  windowSec: number;
  lockSec: number;
}

// Per email: 5 failures in a minute locks sign-in for 10 minutes (design.md 4.2).
export const LOGIN_EMAIL_LIMIT: LimitRule = { max: 5, windowSec: 60, lockSec: 600 };
// Per IP hash: looser, so one shared address can't lock out everyone.
export const LOGIN_IP_LIMIT: LimitRule = { max: 30, windowSec: 60, lockSec: 600 };

export async function lockedUntil(db: AppDb, key: string, now = new Date()) {
  const [row] = await db
    .select({ lockedUntil: rateLimits.lockedUntil })
    .from(rateLimits)
    .where(eq(rateLimits.key, key))
    .limit(1);
  return row?.lockedUntil && row.lockedUntil > now ? row.lockedUntil : null;
}

// Counts one failure atomically. Returns true when this failure triggers a lock.
export async function recordFailure(db: AppDb, key: string, rule: LimitRule, now = new Date()) {
  const cutoff = new Date(now.getTime() - rule.windowSec * 1000).toISOString();
  const nowIso = now.toISOString();
  const [row] = await db
    .insert(rateLimits)
    .values({ key, windowStart: now, count: 1 })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        count: sql`case when ${rateLimits.windowStart} < ${cutoff}::timestamptz then 1 else ${rateLimits.count} + 1 end`,
        windowStart: sql`case when ${rateLimits.windowStart} < ${cutoff}::timestamptz then ${nowIso}::timestamptz else ${rateLimits.windowStart} end`,
      },
    })
    .returning({ count: rateLimits.count });
  if (row.count >= rule.max) {
    await db
      .update(rateLimits)
      .set({ lockedUntil: new Date(now.getTime() + rule.lockSec * 1000), count: 0 })
      .where(eq(rateLimits.key, key));
    return true;
  }
  return false;
}

// Retry-After value in whole seconds for a 429 (RFC 9110 10.2.3): until the lock
// ends when it is known, otherwise the rule's lock length.
export function retryAfter(until: Date | null, now: Date, fallbackSec: number): string {
  const seconds = until ? Math.ceil((until.getTime() - now.getTime()) / 1000) : fallbackSec;
  return String(Math.max(1, seconds));
}

export async function clearFailures(db: AppDb, key: string) {
  await db.delete(rateLimits).where(eq(rateLimits.key, key));
}
