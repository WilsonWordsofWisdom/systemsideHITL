// Poppy Operations extension, version 3 (FR43, FR44, controls PP3, PP4).
//
// A gated request from a Poppy agent that declares the extension gets an
// `operation` next to our own gate fields. The passkey stays the safeguard: the
// operation's revision records whether the account holder has approved with their
// passkey. An approval of a revision that still needs the passkey is declined (the
// agent's word alone never performs an irreversible step); once the passkey
// approval is given the revision changes, and an approval of that revision is
// performed exactly once through the same ticket.
import { isInnerList, parseDictionary, parseList, Token } from "structured-headers";
import { continueUrl } from "@/lib/hitl/response";
import type { Ticket } from "@/lib/hitl/tickets";

export const OPERATIONS_VERSION = "3";
export const MCP_APPROVAL_META = "personalagentprotocol.org/approval";

// IDs are 1 to 256 characters of the URL-safe base64 alphabet (Poppy 8.2).
const ID = /^[A-Za-z0-9_-]{1,256}$/;

export interface PoppyApproval {
  operation_id: string;
  revision: string;
  approver: "user" | "agent";
  approved_at?: number;
  input_type?: string;
}

// The request declares `Poppy-Extensions: "operations";v="3"` (RFC 9651 list).
export function declaresOperations(request: Request): boolean {
  const raw = request.headers.get("poppy-extensions");
  if (!raw) return false;
  try {
    return parseList(raw).some((member) => {
      if (isInnerList(member)) return false;
      const [value, params] = member;
      const name = value instanceof Token ? value.toString() : value;
      return name === "operations" && params.get("v") === OPERATIONS_VERSION;
    });
  } catch {
    return false;
  }
}

function approvalFrom(get: (key: string) => unknown): PoppyApproval | null {
  const operation_id = get("operation_id");
  const revision = get("revision");
  const approver = get("approver");
  if (typeof operation_id !== "string" || !ID.test(operation_id)) return null;
  if (typeof revision !== "string" || !ID.test(revision)) return null;
  if (approver !== "user" && approver !== "agent") return null;
  const approvedAt = get("approved_at");
  const inputType = get("input_type");
  return {
    operation_id,
    revision,
    approver,
    ...(Number.isInteger(approvedAt) ? { approved_at: approvedAt as number } : {}),
    ...(typeof inputType === "string" ? { input_type: inputType.slice(0, 40) } : {}),
  };
}

// `Poppy-Approval` header (RFC 9651 dictionary). Unknown members are ignored; a
// malformed header counts as no approval.
export function approvalFromHeader(request: Request): PoppyApproval | null {
  const raw = request.headers.get("poppy-approval");
  if (!raw) return null;
  try {
    const dict = parseDictionary(raw);
    return approvalFrom((key) => {
      const member = dict.get(key);
      return member && !isInnerList(member) ? member[0] : undefined;
    });
  } catch {
    return null;
  }
}

// MCP carries the approval in params._meta["personalagentprotocol.org/approval"].
export function approvalFromMeta(meta: Record<string, unknown> | undefined): PoppyApproval | null {
  const value = meta?.[MCP_APPROVAL_META];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return approvalFrom((key) => (value as Record<string, unknown>)[key]);
}

const passkeyGiven = (ticket: Ticket) => ticket.state === "approved";

// One set of terms per revision: the payload hash plus the passkey state.
export function revisionFor(ticket: Ticket): string {
  return `${ticket.payloadHash.slice(0, 32)}-${passkeyGiven(ticket) ? "given" : "required"}`;
}

function summaryOf(ticket: Ticket): string {
  const preview = ticket.payloadPreview as { summary?: unknown };
  return String(preview.summary ?? ticket.action);
}

export function operationFor(ticket: Ticket, origin: string) {
  const given = passkeyGiven(ticket);
  return {
    operation_id: ticket.id,
    revision: revisionFor(ticket),
    summary: given
      ? `${summaryOf(ticket)}. The account holder has approved this step with a passkey.`
      : `${summaryOf(ticket)}. The account holder approves this step on the DemoGov Permits website with a passkey before it goes ahead.`,
    terms: {
      action: ticket.action,
      resource_id: ticket.resourceId,
      details: ticket.payloadPreview,
      account_holder_passkey_approval: given ? "given" : "required",
      approval_page: continueUrl(origin, ticket.id),
    },
    expires_at: ticket.expiresAt.toISOString(),
  };
}

export function declinedBody(ticket: Ticket, origin: string) {
  return {
    error: "approval_declined",
    operation_id: ticket.id,
    revision: revisionFor(ticket),
    reason:
      "This step needs the account holder's own approval with a passkey on the DemoGov Permits website, and it has not been given yet.",
    alternative: {
      instructions:
        "The account holder opens the approval page and approves with a passkey. After that, the same request returns an updated operation.",
      references: [{ type: "web", url: continueUrl(origin, ticket.id) }],
    },
  };
}

export const performedBody = (ticket: Ticket) => ({
  operation_id: ticket.id,
  status: "performed",
});
