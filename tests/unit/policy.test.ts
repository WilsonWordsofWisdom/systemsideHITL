// Policy engine (controls C2, C4; J07 "unlisted mutating action is denied").
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ACTOR_CLASSES, POLICY_PATH, getPolicy, parsePolicy } from "@/lib/hitl/policy";

// The spec's table (section 7), which the policy file must match exactly.
const EXPECTED: Record<string, string[]> = {
  //                   human   declared suspected unknown
  create_draft: ["allow", "allow", "allow", "allow"],
  update_draft: ["allow", "allow", "allow", "allow"],
  attach_document: ["allow", "allow", "allow", "allow"],
  submit_application: ["gate", "gate", "gate", "gate"],
  pay_fee: ["gate", "gate", "gate", "gate"],
  update_contact: ["gate", "deny", "deny", "gate"],
  delete_application: ["gate", "gate", "deny", "gate"],
};

const source = readFileSync(POLICY_PATH, "utf8");

describe("policy file", () => {
  const policy = getPolicy();

  it("matches the full action x actor matrix", () => {
    expect(Object.keys(policy.data.actions).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const [action, row] of Object.entries(EXPECTED)) {
      ACTOR_CLASSES.forEach((actor, i) => {
        expect(policy.decide(action, actor), `${action} / ${actor}`).toBe(row[i]);
      });
    }
  });

  it("gates every high-risk action for humans too", () => {
    for (const action of [
      "submit_application",
      "pay_fee",
      "update_contact",
      "delete_application",
    ]) {
      expect(policy.decide(action, "human")).toBe("gate");
    }
  });

  it("denies an unlisted action for every actor (C4)", () => {
    for (const actor of ACTOR_CLASSES) expect(policy.decide("transfer_funds", actor)).toBe("deny");
  });

  it("allows only the explicitly read-only actions without a row", () => {
    expect(policy.decide("list_applications", "suspected_agent")).toBe("allow");
    expect(policy.isListed("get_application")).toBe(true);
    expect(policy.isListed("transfer_funds")).toBe(false);
  });

  it("marks update_contact as critical and keeps the TTL at 10 minutes or less", () => {
    expect(policy.isCritical("update_contact")).toBe(true);
    expect(policy.isCritical("pay_fee")).toBe(false);
    expect(policy.data.gate.ttl_seconds).toBeLessThanOrEqual(600);
  });
});

describe("invalid policy fails to load", () => {
  const broken: [string, string][] = [
    ["malformed YAML", "version: 1\nactions: [unclosed"],
    ["unknown decision", source.replace("pay_fee: { human: gate", "pay_fee: { human: maybe")],
    ["missing actor class", source.replace(", unknown: allow }", " }")],
    ["TTL over 10 minutes", source.replace("ttl_seconds: 600", "ttl_seconds: 601")],
    ["read-only and listed", source.replace("  - get_contact", "  - pay_fee")],
    ["critical without a row", source.replace("  - update_contact", "  - transfer_funds")],
    ["unknown top-level key", `${source}\ndefault: allow\n`],
  ];
  it.each(broken)("%s", (_name, text) => {
    expect(text).not.toBe(source);
    expect(() => parsePolicy(text)).toThrow();
  });
});
