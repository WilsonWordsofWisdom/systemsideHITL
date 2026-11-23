// Experiment flags (PRD 9.4), read at request time so a change needs no rebuild.
type Env = Record<string, string | undefined>;

export const agentHintsOn = (env: Env = process.env) => env.AGENT_HINTS === "on";
export const selfDeclareUiOn = (env: Env = process.env) => (env.SELF_DECLARE_UI ?? "on") === "on";
export const passkeyEnrolmentOpen = (env: Env = process.env) => env.PASSKEY_ENROLMENT === "open";

// HTTP status of a gated response (FR24): 403 by default; 401 or 202 as test variants.
export function gateStatus(env: Env = process.env): 401 | 403 | 202 {
  const v = env.HITL_GATE_STATUS;
  return v === "401" ? 401 : v === "202" ? 202 : 403;
}
