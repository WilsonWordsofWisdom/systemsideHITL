// Policy engine (spec section 7, controls C2-C4). The YAML is parsed and
// validated once; an invalid file throws, so the server fails to boot rather
// than run with a partial policy.
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";

export const ACTOR_CLASSES = ["human", "declared_agent", "suspected_agent", "unknown"] as const;
export type ActorClassName = (typeof ACTOR_CLASSES)[number];
export type Decision = "allow" | "gate" | "deny";

const decision = z.enum(["allow", "gate", "deny"]);
const row = z.strictObject({
  human: decision,
  declared_agent: decision,
  suspected_agent: decision,
  unknown: decision,
});

const PolicyFile = z.strictObject({
  version: z.number().int(),
  read_only: z.array(z.string()),
  actions: z.record(z.string(), row),
  critical: z.array(z.string()).default([]),
  gate: z.strictObject({
    ttl_seconds: z.number().int().min(1).max(600),
    methods: z.array(z.enum(["passkey", "device"])).min(1),
    human_fresh_auth_skip_seconds: z.number().int().min(0),
  }),
});

export type PolicyData = z.infer<typeof PolicyFile>;

export interface Policy {
  data: PolicyData;
  decide(action: string, actor: ActorClassName): Decision;
  isCritical(action: string): boolean;
  // True when the action is listed (as read-only or with a row).
  isListed(action: string): boolean;
}

export function parsePolicy(text: string): Policy {
  const data = PolicyFile.parse(parse(text));
  for (const name of data.read_only) {
    if (data.actions[name]) throw new Error(`${name} is both read-only and listed under actions`);
  }
  for (const name of data.critical) {
    if (!data.actions[name]) throw new Error(`critical action ${name} has no policy row`);
  }
  const readOnly = new Set(data.read_only);
  return {
    data,
    decide(action, actor) {
      const entry = data.actions[action];
      if (entry) return entry[actor];
      // Unlisted mutating actions are denied (control C4).
      return readOnly.has(action) ? "allow" : "deny";
    },
    isCritical: (action) => data.critical.includes(action),
    isListed: (action) => readOnly.has(action) || action in data.actions,
  };
}

export const POLICY_PATH = path.join(process.cwd(), "policy", "hitl-policy.yaml");

let cached: Policy | undefined;

export function getPolicy(): Policy {
  cached ??= parsePolicy(readFileSync(POLICY_PATH, "utf8"));
  return cached;
}
