// Console detail panel (design.md 4.8, FR39): a ticket's timeline and a
// session's timeline, read from hitl_tickets, request_log, sessions and
// session_events.
import { and, asc, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { hitlTickets, requestLog, sessionEvents, sessions } from "../db/schema";
import type { AppDb } from "../db/types";

export type TicketRow = typeof hitlTickets.$inferSelect;

// An approved ticket whose time ran out before the agent came back: shown as
// "approved, not redeemed" and counted as a resume failure (decision 2026-11-21).
export function approvedNotRedeemed(t: Pick<TicketRow, "state" | "expiresAt">, now = new Date()) {
  return t.state === "approved" && t.expiresAt <= now;
}

export interface TimelineStep {
  at: Date;
  label: string;
  detail: string;
}

export async function ticketDetail(db: AppDb, ticketId: string, now = new Date()) {
  const [ticket] = await db.select().from(hitlTickets).where(eq(hitlTickets.id, ticketId)).limit(1);
  if (!ticket) return null;
  const logs = await db
    .select()
    .from(requestLog)
    .where(eq(requestLog.ticketId, ticketId))
    .orderBy(asc(requestLog.ts));
  const actor = ticket.requestedByActor as { class?: string; tier?: string; score?: number };
  const requester = ticket.requestingSessionId
    ? (
        await db
          .select({ runId: sessions.runId, loginActorClass: sessions.loginActorClass })
          .from(sessions)
          .where(eq(sessions.id, ticket.requestingSessionId))
          .limit(1)
      )[0]
    : undefined;

  const steps: TimelineStep[] = [
    {
      at: ticket.createdAt,
      label: "Created",
      detail: `Requested by ${actor.class ?? "unknown"}${typeof actor.score === "number" ? ` (score ${actor.score})` : ""}, session ${(ticket.requestingSessionId ?? "–").slice(0, 8)}`,
    },
  ];
  if (ticket.decidedAt && ticket.state !== "expired") {
    const approved = ticket.approvalMethod !== null;
    const seconds = Math.round((ticket.decidedAt.getTime() - ticket.createdAt.getTime()) / 1000);
    const meta = (ticket.approverMeta ?? {}) as { approverSession?: string };
    steps.push(
      approved
        ? {
            at: ticket.decidedAt,
            label: "Approved",
            detail: `${ticket.approvalMethod === "passkey" ? "Passkey (UV)" : ticket.approvalMethod} by the account holder${meta.approverSession === "approval" ? " on an approval-only session" : ""} · ${Math.floor(seconds / 60)} min ${seconds % 60} s to approve`,
          }
        : {
            at: ticket.decidedAt,
            label: ticket.rejectReason === "superseded" ? "Superseded" : "Declined",
            detail:
              ticket.rejectReason === "superseded"
                ? "A changed request replaced it"
                : "The account holder declined",
          },
    );
  }
  if (ticket.state === "expired") {
    steps.push({
      at: ticket.decidedAt ?? ticket.expiresAt,
      label: "Expired",
      detail: "Not approved in time",
    });
  }
  if (ticket.consumedAt) {
    const redeemed = logs.find((l) => l.reason === "ticket_consumed");
    steps.push({
      at: ticket.consumedAt,
      label: "Consumed",
      detail: `Redeemed by session ${(redeemed?.sessionId ?? ticket.requestingSessionId ?? "–").slice(0, 8)} · executed ${logs.filter((l) => l.reason === "ticket_consumed" && l.outcome === "executed").length} time(s)`,
    });
  }
  return {
    ticket,
    steps,
    attempts: logs,
    runId: requester?.runId ?? null,
    flag: approvedNotRedeemed(ticket, now) ? "approved, not redeemed" : null,
  };
}

const AGENT = new Set(["declared_agent", "suspected_agent"]);

export async function sessionDetail(db: AppDb, sessionId: string) {
  const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  if (!session) return null;
  const events = await db
    .select()
    .from(sessionEvents)
    .where(eq(sessionEvents.sessionId, sessionId))
    .orderBy(asc(sessionEvents.ts));
  const [latest] = await db
    .select({ actorClass: requestLog.actorClass, ts: requestLog.ts })
    .from(requestLog)
    .where(and(eq(requestLog.sessionId, sessionId), isNotNull(requestLog.actorClass)))
    .orderBy(desc(requestLog.ts))
    .limit(1);
  const current = latest?.actorClass ?? null;
  // The login class and the per-request class disagree about whether an agent is
  // acting, or the risk state already says so: a probable handover (FR39, 4.3).
  const disagree = current !== null && AGENT.has(session.loginActorClass) !== AGENT.has(current);
  const probableHandover = disagree || session.riskState === "handover_suspected";
  return { session, events, currentClass: current, probableHandover };
}

// Ticket states for the table, so approved-not-redeemed rows can be highlighted.
export async function ticketStates(db: AppDb, ids: string[]) {
  if (ids.length === 0) return new Map<string, Pick<TicketRow, "state" | "expiresAt">>();
  const rows = await db
    .select({ id: hitlTickets.id, state: hitlTickets.state, expiresAt: hitlTickets.expiresAt })
    .from(hitlTickets)
    .where(inArray(hitlTickets.id, ids));
  return new Map(rows.map((r) => [r.id, r]));
}
