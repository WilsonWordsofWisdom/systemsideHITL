// What an approval covers, read from the ticket row only, never from the URL (T8).
// Shared by the approval page and the phone page (design.md 4.6, 4.7).
import type { Ticket } from "./tickets";

export const ACTOR_LABEL: Record<string, string> = {
  human: "Person",
  declared_agent: "Automated assistant (declared)",
  suspected_agent: "Automated assistant (suspected)",
  unknown: "Unknown",
};

export function previewRows(ticket: Ticket): [string, string][] {
  const p = ticket.payloadPreview as Record<string, unknown>;
  const d = (p.details ?? {}) as Record<string, unknown>;
  const out: [string, string][] = [["Request", String(p.summary ?? ticket.action)]];
  if (d.date) out.push(["Event date", String(d.date)]);
  if (d.attendance) out.push(["Expected attendance", `${d.attendance} people`]);
  if (d.location) out.push(["Location", String(d.location)]);
  if (Array.isArray(p.documents) && p.documents.length) {
    out.push(["Documents", p.documents.join(", ")]);
  }
  if (p.amount) out.push(["Amount", `${p.currency ?? ""} ${p.amount} (mock payment)`.trim()]);
  if (p.recoveryEmail) out.push(["New recovery email", String(p.recoveryEmail)]);
  if (p.phone) out.push(["New recovery phone", String(p.phone)]);
  const actor = (ticket.requestedByActor as { class?: string }).class ?? "unknown";
  out.push(["Requested by", ACTOR_LABEL[actor] ?? actor]);
  out.push(["Expires", `${ticket.expiresAt.toISOString().slice(11, 16)} UTC`]);
  return out;
}
