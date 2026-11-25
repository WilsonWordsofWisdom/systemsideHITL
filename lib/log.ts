// Writes request_log rows (control L1). Phase 2's guard logs every decision here;
// Phase 1 uses it for audited security events such as passkey enrolment (W7).
import { and, eq, inArray } from "drizzle-orm";
import { requestLog } from "./db/schema";
import type { AppDb } from "./db/types";

type Row = typeof requestLog.$inferInsert;

export async function logEvent(db: AppDb, row: Omit<Row, "id" | "ts"> & { ts?: Date }) {
  await db.insert(requestLog).values(row);
}

// How the action a consumed ticket allowed ended: the guard's finish() logs it
// against the ticket. null means it is still running (or never reported).
export async function ticketActionOutcome(db: AppDb, ticketId: string) {
  const [row] = await db
    .select({ outcome: requestLog.outcome })
    .from(requestLog)
    .where(
      and(eq(requestLog.ticketId, ticketId), inArray(requestLog.outcome, ["executed", "error"])),
    )
    .limit(1);
  return (row?.outcome as "executed" | "error" | undefined) ?? null;
}
