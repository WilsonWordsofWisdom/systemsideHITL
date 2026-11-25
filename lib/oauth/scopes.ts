// Scopes (Phase 7, FR42, FR45, control PP8). Poppy agents ask for named scopes;
// clients registered dynamically for MCP keep the single "mcp" scope, which covers
// every tool as before. A scope only lets a request reach the guard: the guard and
// the passkey still decide every gated or denied action.
import type { Policy } from "@/lib/hitl/policy";
import { MCP_SCOPE } from "./metadata";

export const BROWSER_SIGN_IN = "poppy:browser-sign-in";

// Plain-language descriptions, shown on the consent page and in poppy.json.
export const POPPY_SCOPES: Record<string, string> = {
  "applications:read": "See your permit applications and where each one is in the journey.",
  "applications:write": "Start and edit draft applications, including event details and documents.",
  "applications:submit":
    "Ask to submit an application. Each submission still needs your approval with your passkey.",
  "applications:delete":
    "Ask to delete an application. Each deletion still needs your approval with your passkey.",
  payments: "Ask to pay the permit fee. Each payment still needs your approval with your passkey.",
  [BROWSER_SIGN_IN]:
    "Sign the assistant's browser in to this website as you. Submitting, paying and deleting still need your approval with your passkey; recovery details can't be changed by an assistant.",
};

// The journey actions (policy names) each scope reaches.
const SCOPE_ACTIONS: Record<string, string[]> = {
  "applications:read": [
    "list_applications",
    "get_application",
    "get_journey_state",
    "get_approval_status",
  ],
  "applications:write": ["create_draft", "update_draft", "attach_document"],
  "applications:submit": ["submit_application"],
  "applications:delete": ["delete_application"],
  payments: ["pay_fee"],
};

// The scope a policy action needs. update_contact has none: no scope offered to
// agents reaches it, and the policy denies it to agents anyway.
export function scopeForAction(action: string): string | null {
  for (const [scope, actions] of Object.entries(SCOPE_ACTIONS)) {
    if (actions.includes(action)) return scope;
  }
  return null;
}

export function grants(granted: string, needed: string | null): boolean {
  const scopes = granted.split(" ");
  if (scopes.includes(MCP_SCOPE)) return needed !== BROWSER_SIGN_IN;
  return needed !== null && scopes.includes(needed);
}

export type ScopeHint = { changes: "none" | "reversible" | "irreversible"; personal_data: boolean };

// Poppy scope_hints from the policy file: read-only actions change nothing; actions
// allowed for agents are reversible drafts; gated or denied ones are irreversible.
export function scopeHints(policy: Policy): Record<string, ScopeHint> {
  const hints: Record<string, ScopeHint> = {};
  for (const [scope, actions] of Object.entries(SCOPE_ACTIONS)) {
    const rows = actions.map((a) => policy.data.actions[a]).filter(Boolean);
    const changes =
      rows.length === 0
        ? "none"
        : rows.some((r) => r.declared_agent !== "allow")
          ? "irreversible"
          : "reversible";
    hints[scope] = { changes, personal_data: scope !== "payments" };
  }
  // A joined browser can do anything the website offers the account.
  hints[BROWSER_SIGN_IN] = { changes: "irreversible", personal_data: true };
  return hints;
}

// Parses a requested scope string; null if it names a scope we don't offer.
export function parseScopes(raw: string | undefined): string[] | null {
  const scopes = [...new Set((raw ?? "").split(" ").filter(Boolean))];
  if (scopes.length === 0 || scopes.some((s) => !(s in POPPY_SCOPES))) return null;
  return scopes;
}
