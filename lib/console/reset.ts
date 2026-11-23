// "Reset demo data" (spec 11.1, J11, control L3): clears logs, tickets and
// sessions and restores the seed applications, in one transaction. Users and
// their passwords, passkeys (the owner's real approver credentials), run
// ground truth and MCP clients are kept. The caller logs the reset afterwards.
import { sql } from "drizzle-orm";
import {
  applications,
  clientSignals,
  hitlTickets,
  rateLimits,
  requestLog,
  sessionEvents,
  sessions,
  users,
  webauthnChallenges,
} from "../db/schema";
import { seedApplications } from "../db/seed-data";
import type { AppDb } from "../db/types";

export async function resetDemoData(db: AppDb) {
  return db.transaction(async (tx) => {
    const count = async (table: Parameters<typeof tx.delete>[0]) =>
      (await tx.delete(table).returning({ one: sql`1` })).length;
    // Children before parents (session_events and client_signals reference sessions).
    const removed = {
      requestLog: await count(requestLog),
      sessionEvents: await count(sessionEvents),
      clientSignals: await count(clientSignals),
      tickets: await count(hitlTickets),
      challenges: await count(webauthnChallenges),
      sessions: await count(sessions),
      rateLimits: await count(rateLimits),
      applications: await count(applications),
    };
    await tx.insert(applications).values(seedApplications);
    await tx.update(users).set({ phone: null, recoveryEmail: null });
    return removed;
  });
}
