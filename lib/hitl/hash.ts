// Approval hash (FR17, control T1): SHA-256 of canonical JSON covering the
// action, the resource, the request body and a snapshot of the stored resource.
import { sha256Hex } from "../auth/crypto";

// Canonical JSON: object keys sorted at every level, undefined members dropped.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

// Fields that differ between the first request and the retry without changing
// what is being approved. Named per action so an omission is visible (risk 8).
const COMMON_VOLATILE = ["csrf", "hitl_ticket", "signals", "continue_url"];
export const VOLATILE_FIELDS: Record<string, readonly string[]> = {
  submit_application: COMMON_VOLATILE,
  pay_fee: COMMON_VOLATILE,
  update_contact: COMMON_VOLATILE,
  delete_application: COMMON_VOLATILE,
};

export function stripVolatile(action: string, body: Record<string, unknown>) {
  const drop = new Set(VOLATILE_FIELDS[action] ?? COMMON_VOLATILE);
  return Object.fromEntries(Object.entries(body).filter(([k]) => !drop.has(k)));
}

export function payloadHash(input: {
  action: string;
  resourceId: string | null;
  body: Record<string, unknown>;
  snapshot: unknown;
}): string {
  return sha256Hex(
    canonicalJson({
      action: input.action,
      resourceId: input.resourceId,
      body: stripVolatile(input.action, input.body),
      snapshot: sha256Hex(canonicalJson(input.snapshot ?? null)),
    }),
  );
}
