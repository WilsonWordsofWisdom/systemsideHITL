import "server-only";
import QRCode from "qrcode";
import { appConfig } from "@/lib/app";
import { getDb } from "@/lib/db/server";
import { autoresumeOn, handoffMode } from "@/lib/flags";
import { continueUrl, gatedBody } from "@/lib/hitl/response";
import { getTicket, type Ticket } from "@/lib/hitl/tickets";
import { HandoffLive } from "./handoff-live";

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

// Where the Continue button resubmits each gated action (the same routes the
// forms use, so the guard redeems the ticket).
function resubmitAction(ticket: Ticket) {
  const id = encodeURIComponent(ticket.resourceId ?? "");
  switch (ticket.action) {
    case "submit_application":
      return `/api/applications/${id}/submit`;
    case "pay_fee":
      return `/api/applications/${id}/pay`;
    case "delete_application":
      return `/api/applications/${id}/delete`;
    case "update_contact":
      return "/api/account/contact";
    default:
      return null;
  }
}

// The "Human approval needed" panel (spec 9.2, design.md 4.5): link, QR code, live
// status and countdown, Continue or auto-resume, and the machine-readable JSON.
export async function HandoffPanel({ ticket, csrf }: { ticket: Ticket; csrf: string }) {
  const origin = appConfig().appOrigin;
  const link = continueUrl(origin, ticket.id);
  const preview = ticket.payloadPreview as { summary?: unknown; request?: unknown };
  const qrSvg = await QRCode.toString(link, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
  // Escape "<" so the JSON can't close the script element.
  const json = JSON.stringify(gatedBody(ticket, origin)).replace(/</g, "\\u003c");
  const fields = Object.fromEntries(
    Object.entries((preview.request ?? {}) as Record<string, unknown>).map(([k, v]) => [
      k,
      String(v),
    ]),
  );

  return (
    <>
      <HandoffLive
        ticketId={ticket.id}
        summary={String(preview.summary ?? ticket.action)}
        link={link}
        qrSvg={qrSvg}
        expiresAt={ticket.expiresAt.toISOString()}
        initialState={ticket.state}
        initialReason={ticket.rejectReason}
        resubmit={{ action: resubmitAction(ticket) ?? "/applications", fields }}
        csrf={csrf}
        autoresume={autoresumeOn()}
        redirectLink={handoffMode() === "both"}
      />
      {ticket.state === "pending" && (
        <script
          type="application/json"
          id="hitl-handoff"
          dangerouslySetInnerHTML={{ __html: json }}
        />
      )}
    </>
  );
}
