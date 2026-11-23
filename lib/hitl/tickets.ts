// HITL ticket service (spec section 8, controls T1-T6). Every state change is a
// single conditional UPDATE, so concurrent requests can't both win. Expiry is
// evaluated against `now` at read, approve and consume time, never by a cron.
import { and, eq, gt, lte } from "drizzle-orm";
import { randomToken } from "../auth/crypto";
import { hitlTickets } from "../db/schema";
import type { AppDb } from "../db/types";

export type Ticket = typeof hitlTickets.$inferSelect;
export type TicketState = Ticket["state"];

// "hitl_" + 32 random bytes (256 bits) from the CSPRNG (control T4).
export function newTicketId() {
  return `hitl_${randomToken(32)}`;
}

export const TICKET_ID_PATTERN = /^hitl_[A-Za-z0-9_-]{43}$/;

export interface TicketRequest {
  userId: string;
  action: string;
  resourceId: string | null;
  payloadHash: string;
  preview: Record<string, unknown>;
  actor: Record<string, unknown>;
  sessionId: string | null;
  clientId?: string | null;
  ttlSeconds: number;
}

// Marks a pending ticket past its expiry as expired. Returns the fresh row.
async function settleExpiry(db: AppDb, ticket: Ticket, now: Date): Promise<Ticket> {
  if (ticket.state !== "pending" || ticket.expiresAt > now) return ticket;
  const [row] = await db
    .update(hitlTickets)
    .set({ state: "expired", decidedAt: now })
    .where(
      and(
        eq(hitlTickets.id, ticket.id),
        eq(hitlTickets.state, "pending"),
        lte(hitlTickets.expiresAt, now),
      ),
    )
    .returning();
  return row ?? (await rawGet(db, ticket.id)) ?? ticket;
}

async function rawGet(db: AppDb, id: string) {
  const [row] = await db.select().from(hitlTickets).where(eq(hitlTickets.id, id)).limit(1);
  return row;
}

export async function getTicket(db: AppDb, id: string, now = new Date()) {
  if (!TICKET_ID_PATTERN.test(id)) return undefined;
  const row = await rawGet(db, id);
  return row ? settleExpiry(db, row, now) : undefined;
}

// Returns the requesting session's pending ticket for the same action and
// resource when the payload is identical; otherwise supersedes it with a new one
// (decision 2026-11-21, confirmed by the owner 2026-11-23).
export async function requestTicket(
  db: AppDb,
  req: TicketRequest,
  now = new Date(),
): Promise<{ ticket: Ticket; reused: boolean; superseded: string[] }> {
  const superseded: string[] = [];
  if (req.sessionId) {
    const pending = await db
      .select()
      .from(hitlTickets)
      .where(
        and(
          eq(hitlTickets.userId, req.userId),
          eq(hitlTickets.requestingSessionId, req.sessionId),
          eq(hitlTickets.action, req.action),
          eq(hitlTickets.state, "pending"),
          gt(hitlTickets.expiresAt, now),
        ),
      );
    for (const t of pending) {
      if (t.resourceId !== req.resourceId) continue;
      if (t.payloadHash === req.payloadHash) return { ticket: t, reused: true, superseded };
      const [rejected] = await db
        .update(hitlTickets)
        .set({ state: "rejected", rejectReason: "superseded", decidedAt: now })
        .where(and(eq(hitlTickets.id, t.id), eq(hitlTickets.state, "pending")))
        .returning({ id: hitlTickets.id });
      if (rejected) superseded.push(rejected.id);
    }
  }
  const [ticket] = await db
    .insert(hitlTickets)
    .values({
      id: newTicketId(),
      userId: req.userId,
      action: req.action,
      resourceId: req.resourceId,
      payloadHash: req.payloadHash,
      payloadPreview: req.preview,
      requestedByActor: req.actor,
      requestingSessionId: req.sessionId,
      requestingClientId: req.clientId ?? null,
      createdAt: now,
      expiresAt: new Date(now.getTime() + req.ttlSeconds * 1000),
    })
    .returning();
  return { ticket, reused: false, superseded };
}

// pending -> approved, only before expiry (control T5). Returns the new row or null.
export async function approveTicket(
  db: AppDb,
  id: string,
  approval: { method: "passkey" | "device" | "otp"; meta: Record<string, unknown> },
  now = new Date(),
) {
  const [row] = await db
    .update(hitlTickets)
    .set({
      state: "approved",
      approvalMethod: approval.method,
      approverMeta: approval.meta,
      decidedAt: now,
    })
    .where(
      and(eq(hitlTickets.id, id), eq(hitlTickets.state, "pending"), gt(hitlTickets.expiresAt, now)),
    )
    .returning();
  return row ?? null;
}

// pending -> rejected (human declines).
export async function rejectTicket(db: AppDb, id: string, reason: string, now = new Date()) {
  const [row] = await db
    .update(hitlTickets)
    .set({ state: "rejected", rejectReason: reason, decidedAt: now })
    .where(and(eq(hitlTickets.id, id), eq(hitlTickets.state, "pending")))
    .returning();
  return row ?? null;
}

export type RedeemFailure =
  | "not_found"
  | "wrong_session"
  | "not_approved"
  | "rejected"
  | "expired"
  | "consumed"
  | "payload_mismatch";

export interface Redemption {
  userId: string;
  action: string;
  resourceId: string | null;
  payloadHash: string;
  sessionId: string | null;
  clientId?: string | null;
}

// The checks that don't need the payload: who is redeeming and the ticket's state.
// The guard runs these before the action's preconditions, so a replayed ticket is
// reported as "consumed" rather than as the action's own error.
export function stateFailure(
  ticket: Ticket,
  r: Pick<Redemption, "userId" | "sessionId" | "clientId">,
  now: Date,
): RedeemFailure | null {
  // Another user's ticket, or another session's, is the same failure (FR19, J07).
  if (ticket.userId !== r.userId) return "wrong_session";
  const boundToSession = ticket.requestingSessionId !== null;
  if (boundToSession && ticket.requestingSessionId !== r.sessionId) return "wrong_session";
  if (!boundToSession && ticket.requestingClientId !== (r.clientId ?? null)) return "wrong_session";
  if (ticket.state === "consumed") return "consumed";
  if (ticket.state === "rejected") return "rejected";
  if (ticket.state === "expired" || ticket.expiresAt <= now) return "expired";
  if (ticket.state === "pending") return "not_approved";
  return null;
}

function failureFor(ticket: Ticket, r: Redemption, now: Date): RedeemFailure | null {
  const failure = stateFailure(ticket, r, now);
  if (failure) return failure;
  if (
    ticket.action !== r.action ||
    ticket.resourceId !== r.resourceId ||
    ticket.payloadHash !== r.payloadHash
  ) {
    return "payload_mismatch";
  }
  return null;
}

// approved -> consumed, exactly once (control T2). Every binding is re-checked in
// the same UPDATE, so a race between the check and the write can't let a second
// request through.
export async function redeemTicket(
  db: AppDb,
  id: string,
  r: Redemption,
  now = new Date(),
): Promise<{ ok: true; ticket: Ticket } | { ok: false; reason: RedeemFailure; ticket?: Ticket }> {
  const ticket = await getTicket(db, id, now);
  if (!ticket) return { ok: false, reason: "not_found" };
  const failure = failureFor(ticket, r, now);
  if (failure) return { ok: false, reason: failure, ticket };

  const [consumed] = await db
    .update(hitlTickets)
    .set({ state: "consumed", consumedAt: now })
    .where(
      and(
        eq(hitlTickets.id, id),
        eq(hitlTickets.state, "approved"),
        eq(hitlTickets.userId, r.userId),
        eq(hitlTickets.action, r.action),
        eq(hitlTickets.payloadHash, r.payloadHash),
        gt(hitlTickets.expiresAt, now),
      ),
    )
    .returning();
  if (consumed) return { ok: true, ticket: consumed };
  const latest = (await rawGet(db, id)) ?? ticket;
  return { ok: false, reason: failureFor(latest, r, now) ?? "consumed", ticket: latest };
}
