// Experiment flags (PRD 9.4), read at request time so a change needs no rebuild.
type Env = Record<string, string | undefined>;

export const agentHintsOn = (env: Env = process.env) => env.AGENT_HINTS === "on";
export const selfDeclareUiOn = (env: Env = process.env) => (env.SELF_DECLARE_UI ?? "on") === "on";
export const passkeyEnrolmentOpen = (env: Env = process.env) => env.PASSKEY_ENROLMENT === "open";

// How a gated web form hands off to the human (FR26): the panel (default), a
// server-side redirect to the approval page, or both. Fixed per run.
export type HandoffMode = "panel" | "redirect" | "both";
export function handoffMode(env: Env = process.env): HandoffMode {
  const v = env.HITL_HANDOFF_MODE;
  return v === "redirect" || v === "both" ? v : "panel";
}

// Resubmit automatically once approved, instead of offering Continue (FR27).
export const autoresumeOn = (env: Env = process.env) => env.HITL_AUTORESUME === "on";

// How a gated MCP tool call asks for approval (FR32): a normal tool result (the
// default), or URL elicitation for clients that declare it.
export type McpGateMode = "tool_result" | "elicitation";
export const mcpGateMode = (env: Env = process.env): McpGateMode =>
  env.MCP_GATE_MODE === "elicitation" ? "elicitation" : "tool_result";

// tools/list shows only the tools the journey state allows next (FR33). A
// convenience only: hidden tools stay callable and the guard still decides (M5).
export const mcpStepScopedTools = (env: Env = process.env) => env.MCP_STEP_SCOPED_TOOLS === "on";

// HTTP status of a gated response (FR24): 403 by default; 401 or 202 as test variants.
export function gateStatus(env: Env = process.env): 401 | 403 | 202 {
  const v = env.HITL_GATE_STATUS;
  return v === "401" ? 401 : v === "202" ? 202 : 403;
}
