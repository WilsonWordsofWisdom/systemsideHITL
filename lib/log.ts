// Writes request_log rows (control L1). Phase 2's guard logs every decision here;
// Phase 1 uses it for audited security events such as passkey enrolment (W7).
import { requestLog } from "./db/schema";
import type { AppDb } from "./db/types";

type Row = typeof requestLog.$inferInsert;

export async function logEvent(db: AppDb, row: Omit<Row, "id" | "ts"> & { ts?: Date }) {
  await db.insert(requestLog).values(row);
}
