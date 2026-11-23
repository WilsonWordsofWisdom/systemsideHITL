// Gated response contract (spec 9.1, FR21, FR24, FR25, controls P1-P3, T7).
import { describe, expect, it } from "vitest";
import { findModelDirectedText } from "@/lib/content";
import { gateStatus } from "@/lib/flags";
import {
  GATED_MESSAGE,
  STEP_UP_HEADER,
  deniedBody,
  gatedBody,
  ticketInvalidBody,
} from "@/lib/hitl/response";
import type { RedeemFailure, Ticket } from "@/lib/hitl/tickets";

const ORIGIN = "https://hitltest.vercel.app";
const ticket = {
  id: "hitl_abc",
  action: "submit_application",
  expiresAt: new Date("2026-12-01T09:10:00Z"),
} as Ticket;

describe("gated body", () => {
  const body = gatedBody(ticket, ORIGIN);

  it("follows the requires_human_approval contract", () => {
    expect(body).toEqual({
      status: "requires_human_approval",
      action: "submit_application",
      ticket_id: "hitl_abc",
      continue_url: "https://hitltest.vercel.app/approve/hitl_abc",
      message_for_user: GATED_MESSAGE,
      resume: {
        poll: "/api/hitl/hitl_abc",
        retry_with_header: "X-HITL-Ticket",
        expires_at: "2026-12-01T09:10:00.000Z",
      },
    });
    expect(STEP_UP_HEADER).toContain('error="insufficient_user_authentication"');
  });

  it("builds continue_url from APP_ORIGIN only (T7)", () => {
    expect(new URL(body.continue_url).origin).toBe(ORIGIN);
  });
});

describe("agent-visible messages", () => {
  const reasons: RedeemFailure[] = [
    "not_found",
    "wrong_session",
    "not_approved",
    "rejected",
    "expired",
    "consumed",
    "payload_mismatch",
  ];
  const messages = [
    GATED_MESSAGE,
    deniedBody("update_contact", "policy").message_for_user,
    deniedBody("delete_application", "policy").message_for_user,
    deniedBody("pay_fee", "rate_limited").message_for_user,
    ...reasons.map((r) => ticketInvalidBody("pay_fee", "hitl_x", r).message_for_user),
  ];

  it.each(messages)("is declarative and free of model-directed text: %s", (m) => {
    expect(findModelDirectedText(m)).toEqual([]);
    expect(m).not.toMatch(/hitl_|token|password|secret/i);
  });
});

describe("gate status flag (FR24)", () => {
  it("defaults to 403 and accepts 401 or 202", () => {
    expect(gateStatus({})).toBe(403);
    expect(gateStatus({ HITL_GATE_STATUS: "401" })).toBe(401);
    expect(gateStatus({ HITL_GATE_STATUS: "202" })).toBe(202);
    expect(gateStatus({ HITL_GATE_STATUS: "200" })).toBe(403);
  });
});

describe("handoff flags (FR26, FR27)", () => {
  it("handoff mode defaults to panel and accepts redirect or both", async () => {
    const { handoffMode, autoresumeOn } = await import("@/lib/flags");
    expect(handoffMode({})).toBe("panel");
    expect(handoffMode({ HITL_HANDOFF_MODE: "redirect" })).toBe("redirect");
    expect(handoffMode({ HITL_HANDOFF_MODE: "both" })).toBe("both");
    expect(handoffMode({ HITL_HANDOFF_MODE: "https://evil" })).toBe("panel");
    expect(autoresumeOn({})).toBe(false);
    expect(autoresumeOn({ HITL_AUTORESUME: "on" })).toBe(true);
  });
});
