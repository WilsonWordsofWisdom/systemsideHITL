// Poppy Operations v3 parsing and shapes (FR43, FR44, controls PP3, PP4).
import { describe, expect, it } from "vitest";
import { findModelDirectedText } from "@/lib/content";
import type { Ticket } from "@/lib/hitl/tickets";
import {
  approvalFromHeader,
  approvalFromMeta,
  declaresOperations,
  declinedBody,
  operationFor,
  revisionFor,
} from "@/lib/poppy/operations";

const ORIGIN = "https://hitltest.vercel.app";
const ID = /^[A-Za-z0-9_-]{1,256}$/;
const req = (headers: Record<string, string>) => new Request(`${ORIGIN}/api/x`, { headers });

const ticket = (state: Ticket["state"]) =>
  ({
    id: "hitl_AbcDEF0123456789abcdef0123456789abcdef01234",
    userId: "u",
    action: "submit_application",
    resourceId: "app-1",
    payloadHash: "9f2c".repeat(16),
    payloadPreview: { summary: 'Submit the application "Riverside Picnic"', attendance: 80 },
    state,
    expiresAt: new Date("2026-12-01T09:10:00Z"),
  }) as unknown as Ticket;

describe("Poppy-Extensions", () => {
  it.each([
    ['"operations";v="3"', true],
    ['operations;v="3"', true],
    ['"links";v="1", "operations";v="3"', true],
    ['"operations";v="2"', false],
    ['"operations"', false],
    ['"operations";v=3', false],
    ["not a list (", false],
  ])("%s declares v3: %s", (value, ok) => {
    expect(declaresOperations(req({ "poppy-extensions": value }))).toBe(ok);
  });
  it("is absent without the header", () => {
    expect(declaresOperations(req({}))).toBe(false);
  });
});

describe("Poppy-Approval", () => {
  it("reads the spec's example and ignores unknown members", () => {
    const a = approvalFromHeader(
      req({
        "poppy-approval":
          'operation_id="exc_5Rt2", revision="1791487200-k3Jd9Qx2mW8v", approver="user", approved_at=1791487260, input_type="tap", reference="apr_01JD8ZK3Q9", extra="x"',
      }),
    );
    expect(a).toEqual({
      operation_id: "exc_5Rt2",
      revision: "1791487200-k3Jd9Qx2mW8v",
      approver: "user",
      approved_at: 1791487260,
      input_type: "tap",
    });
  });
  it.each([
    'operation_id="a", revision="b"',
    'operation_id="a", revision="b", approver="robot"',
    'operation_id="a b", revision="b", approver="user"',
    `operation_id="${"a".repeat(257)}", revision="b", approver="user"`,
    "operation_id=a, (broken",
  ])("treats %j as no approval", (value) => {
    expect(approvalFromHeader(req({ "poppy-approval": value }))).toBeNull();
  });
  it("reads the MCP _meta form", () => {
    expect(
      approvalFromMeta({
        "personalagentprotocol.org/approval": {
          operation_id: "a",
          revision: "b",
          approver: "agent",
        },
      }),
    ).toEqual({ operation_id: "a", revision: "b", approver: "agent" });
    expect(approvalFromMeta(undefined)).toBeNull();
    expect(approvalFromMeta({ "personalagentprotocol.org/approval": "x" })).toBeNull();
  });
});

describe("operation", () => {
  it("has the required members with valid IDs and an RFC 3339 expiry", () => {
    const op = operationFor(ticket("pending"), ORIGIN);
    expect(Object.keys(op).sort()).toEqual([
      "expires_at",
      "operation_id",
      "revision",
      "summary",
      "terms",
    ]);
    expect(op.operation_id).toMatch(ID);
    expect(op.revision).toMatch(ID);
    expect(op.expires_at).toBe("2026-12-01T09:10:00.000Z");
    expect(op.terms).toMatchObject({
      action: "submit_application",
      account_holder_passkey_approval: "required",
      approval_page: `${ORIGIN}/approve/${ticket("pending").id}`,
    });
  });

  it("changes revision when the account holder approves with a passkey", () => {
    expect(revisionFor(ticket("pending"))).not.toBe(revisionFor(ticket("approved")));
    expect(operationFor(ticket("approved"), ORIGIN).terms.account_holder_passkey_approval).toBe(
      "given",
    );
  });

  it("is declarative, as is the decline", () => {
    for (const t of [ticket("pending"), ticket("approved")]) {
      expect(findModelDirectedText(JSON.stringify(operationFor(t, ORIGIN)))).toEqual([]);
    }
    const declined = declinedBody(ticket("pending"), ORIGIN);
    expect(findModelDirectedText(JSON.stringify(declined))).toEqual([]);
    expect(declined).toMatchObject({
      error: "approval_declined",
      revision: revisionFor(ticket("pending")),
      alternative: {
        references: [{ type: "web", url: `${ORIGIN}/approve/${ticket("pending").id}` }],
      },
    });
  });
});
