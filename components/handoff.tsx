import "server-only";
import { appConfig } from "@/lib/app";
import { getDb } from "@/lib/db/server";
import { continueUrl, gatedBody } from "@/lib/hitl/response";
import { getTicket, type Ticket } from "@/lib/hitl/tickets";
import { Notice } from "./journey";

// Loads the ticket named in ?ticket= for a gated step page. Only the session
// that requested it sees the panel; any other value is ignored (FR19, FR21).
export async function loadHandoff(
  param: string | string[] | undefined,
  current: { user: { id: string }; session: { id: string } },
): Promise<Ticket | null> {
  if (typeof param !== "string") return null;
  const ticket = await getTicket(getDb(), param);
  if (!ticket || ticket.userId !== current.user.id) return null;
  if (ticket.requestingSessionId !== current.session.id) return null;
  return ticket;
}

// The "Human approval needed" panel (spec 9.2, design.md 4.5). Phase 2 slice C
// adds the QR code, live status with countdown and the Continue button.
export function HandoffPanel({ ticket }: { ticket: Ticket }) {
  const origin = appConfig().appOrigin;
  const summary = String(ticket.payloadPreview.summary ?? ticket.action);
  const link = continueUrl(origin, ticket.id);
  // Escape "<" so the JSON can't close the script element.
  const json = JSON.stringify(gatedBody(ticket, origin)).replace(/</g, "\\u003c");

  if (ticket.state === "pending") {
    return (
      <section
        role="alert"
        aria-live="assertive"
        className="mb-6 rounded-xl border border-outline-variant bg-white p-6"
      >
        <h2 className="mb-2 text-[22px] leading-7">Human approval needed</h2>
        <p className="mb-4">{summary} needs approval from the account holder with their passkey.</p>
        <p className="mb-2 text-sm text-on-surface-variant">Approval link</p>
        <p className="mb-4 break-all">
          <a href={link} className="text-primary underline underline-offset-4">
            {link}
          </a>
        </p>
        <p className="text-sm text-on-surface-variant">
          Status: waiting for approval. The request expires at{" "}
          <time dateTime={ticket.expiresAt.toISOString()}>
            {ticket.expiresAt.toISOString().slice(11, 16)} UTC
          </time>
          .
        </p>
        <script
          type="application/json"
          id="hitl-handoff"
          dangerouslySetInnerHTML={{ __html: json }}
        />
      </section>
    );
  }
  if (ticket.state === "approved") {
    return (
      <Notice tone="success" title="Approved: continue">
        The account holder approved this request. Sending the same request again with this approval
        completes it.
      </Notice>
    );
  }
  const ended: Record<string, string> = {
    rejected:
      ticket.rejectReason === "superseded"
        ? "A newer request replaced this one."
        : "The account holder declined this request.",
    expired: "This request expired. Approvals last 10 minutes.",
    consumed: "This approval has been used.",
  };
  return (
    <Notice tone="warn" title="This approval request has ended">
      {ended[ticket.state]} Submitting again creates a new request.
    </Notice>
  );
}
