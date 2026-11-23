// Approval hash (FR17, control T1): canonical JSON, per-action volatile fields, snapshot binding.
import { describe, expect, it } from "vitest";
import { VOLATILE_FIELDS, canonicalJson, payloadHash, stripVolatile } from "@/lib/hitl/hash";
import { getPolicy } from "@/lib/hitl/policy";

const base = {
  action: "submit_application",
  resourceId: "00000000-0000-4000-8000-000000000101",
  body: { declaration: "on" },
  snapshot: { version: 3, details: { attendance: 80, date: "2026-12-12" } },
};

describe("canonicalJson", () => {
  it("sorts keys at every level and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: null } })).toBe(
      '{"a":{"c":null,"d":[2,1]},"b":1}',
    );
    expect(canonicalJson({ a: { c: null, d: [2, 1] }, b: 1 })).toBe(
      canonicalJson({ b: 1, a: { d: [2, 1], c: null } }),
    );
  });

  it("drops undefined members", () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });
});

describe("payloadHash", () => {
  it("is deterministic and independent of key order", () => {
    const reordered = {
      ...base,
      snapshot: { details: { date: "2026-12-12", attendance: 80 }, version: 3 },
    };
    expect(payloadHash(base)).toBe(payloadHash(reordered));
    expect(payloadHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("ignores the named volatile fields", () => {
    const withVolatile = {
      ...base,
      body: { declaration: "on", csrf: "x", hitl_ticket: "hitl_y", continue_url: "https://evil" },
    };
    expect(payloadHash(withVolatile)).toBe(payloadHash(base));
  });

  it("changes when the draft is edited after approval (T5)", () => {
    const edited = { ...base, snapshot: { ...base.snapshot, version: 4 } };
    const bigger = {
      ...base,
      snapshot: { version: 3, details: { attendance: 800, date: "2026-12-12" } },
    };
    expect(payloadHash(edited)).not.toBe(payloadHash(base));
    expect(payloadHash(bigger)).not.toBe(payloadHash(base));
  });

  it("changes with the body, action or resource", () => {
    expect(payloadHash({ ...base, body: { declaration: "agree" } })).not.toBe(payloadHash(base));
    expect(payloadHash({ ...base, action: "pay_fee" })).not.toBe(payloadHash(base));
    expect(payloadHash({ ...base, resourceId: "other" })).not.toBe(payloadHash(base));
  });

  it("has a named volatile list for every action the policy can gate", () => {
    const { actions } = getPolicy().data;
    const gateable = Object.entries(actions)
      .filter(([, row]) => Object.values(row).includes("gate"))
      .map(([name]) => name);
    for (const action of gateable) expect(VOLATILE_FIELDS[action], action).toBeDefined();
    expect(stripVolatile("pay_fee", { csrf: "a", keep: "b" })).toEqual({ keep: "b" });
  });
});
