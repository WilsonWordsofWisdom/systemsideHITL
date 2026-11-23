// Agent-visible responses from the guard (spec 9.1, FR21, FR24, FR25, P1-P3).
// Messages are declarative and addressed to the person; no secrets, tokens or
// personal data. URLs are built from APP_ORIGIN only, never from the request.
import type { RedeemFailure, Ticket } from "./tickets";

export const STEP_UP_HEADER =
  'Bearer error="insufficient_user_authentication", acr_values="urn:demogov:hitl:passkey"';

export const GATED_MESSAGE = "A person must approve this step. Open the link to continue.";

export function continueUrl(appOrigin: string, ticketId: string) {
  return new URL(`/approve/${encodeURIComponent(ticketId)}`, appOrigin).toString();
}

export function gatedBody(ticket: Ticket, appOrigin: string) {
  return {
    status: "requires_human_approval",
    action: ticket.action,
    ticket_id: ticket.id,
    continue_url: continueUrl(appOrigin, ticket.id),
    message_for_user: GATED_MESSAGE,
    resume: {
      poll: `/api/hitl/${ticket.id}`,
      retry_with_header: "X-HITL-Ticket",
      expires_at: ticket.expiresAt.toISOString(),
    },
  };
}

const DENIED_MESSAGES: Record<string, string> = {
  update_contact:
    "The account holder must make this change. Recovery email and phone can't be changed by an automated assistant. The account holder can change them after signing in.",
};

export function deniedBody(action: string, reason: "policy" | "rate_limited") {
  if (reason === "rate_limited") {
    return {
      status: "rate_limited",
      action,
      message_for_user:
        "Too many approval requests were made in a short time. Try again in a minute.",
    };
  }
  return {
    status: "denied",
    action,
    message_for_user:
      DENIED_MESSAGES[action] ??
      "This step can't be done in this session. The account holder can do it after signing in.",
  };
}

const INVALID_MESSAGES: Record<RedeemFailure, string> = {
  not_found: "This approval doesn't exist.",
  wrong_session: "This approval was issued to a different session.",
  not_approved: "This step hasn't been approved yet.",
  rejected: "The account holder declined this request.",
  expired: "The approval expired. Approvals last 10 minutes.",
  consumed: "This approval has already been used.",
  payload_mismatch: "The request changed after it was approved.",
};

export function ticketInvalidBody(action: string, ticketId: string, reason: RedeemFailure) {
  return {
    status: "ticket_invalid",
    action,
    ticket_id: ticketId,
    reason,
    message_for_user: `${INVALID_MESSAGES[reason]}${reason === "not_approved" ? "" : " Sending the request again without it starts a new approval."}`,
  };
}
