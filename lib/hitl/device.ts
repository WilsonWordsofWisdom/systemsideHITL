// The phone page's view (FR22, design.md 4.7): a simulated out-of-band channel.
// Every pending ticket of the signed-in account holder appears here, as if each
// request were pushed to their phone. It is always the approver's own account;
// the user ID in the URL only decides whether the page belongs to them.
import { and, desc, eq, gt, inArray } from "drizzle-orm";
import { hitlTickets } from "../db/schema";
import type { AppDb } from "../db/types";

const MAX_CARDS = 20;
const RECENT_MS = 10 * 60_000;

export async function pendingTickets(db: AppDb, userId: string, now = new Date()) {
  return db
    .select()
    .from(hitlTickets)
    .where(
      and(
        eq(hitlTickets.userId, userId),
        eq(hitlTickets.state, "pending"),
        gt(hitlTickets.expiresAt, now),
      ),
    )
    .orderBy(desc(hitlTickets.createdAt))
    .limit(MAX_CARDS);
}

// Approvals and declines from the last 10 minutes, shown as confirmations.
export async function recentDecisions(db: AppDb, userId: string, now = new Date()) {
  return db
    .select()
    .from(hitlTickets)
    .where(
      and(
        eq(hitlTickets.userId, userId),
        inArray(hitlTickets.state, ["approved", "consumed", "rejected"]),
        gt(hitlTickets.decidedAt, new Date(now.getTime() - RECENT_MS)),
      ),
    )
    .orderBy(desc(hitlTickets.decidedAt))
    .limit(MAX_CARDS);
}

// What the live feed compares: the pending ticket IDs, newest first.
export async function pendingIds(db: AppDb, userId: string, now = new Date()) {
  return (await pendingTickets(db, userId, now)).map((t) => t.id);
}
