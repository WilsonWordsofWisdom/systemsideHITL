// Poppy discovery (Poppy 1.0 sections 3 and 9; FR42, controls PP1, PP2).
//
// The document declares only what the site supports: sign-in with named scopes
// (`auth`), the website (`web`), the tasks endpoint and Operations. An API is
// listed only once it accepts Poppy Sessions and enforces scopes.
import type { Policy } from "@/lib/hitl/policy";
import { POPPY_SCOPES, scopeHints } from "@/lib/oauth/scopes";
import { JOIN_PATH } from "./join";
import { OPERATIONS_VERSION } from "./operations";
import { POPPY_VERSION } from "./version";

export const POPPY_PATHS = {
  document: "/.well-known/poppy.json",
  tasks: "/api/poppy/tasks",
  feedback: "/api/poppy/feedback",
} as const;

export function poppyDocument(origin: string, policy: Policy) {
  return {
    protocol_version: POPPY_VERSION,
    organization: {
      name: "DemoGov Permits (prototype)",
      // The host that serves the document, with its port when that isn't the default.
      domain: new URL(origin).host,
    },
    // One authorization server (this app), so `issuer` can be left out.
    auth: { scopes: POPPY_SCOPES, scope_hints: scopeHints(policy) },
    // The MCP server accepts Poppy Sessions and enforces these scopes (slice C2).
    apis: [
      {
        type: "mcp",
        url: `${origin}/mcp`,
        description:
          "Permit applications as MCP tools: browse, draft, and ask to submit, pay or delete. Submitting, paying and deleting need the account holder's passkey approval.",
      },
    ],
    // Browser join (slice C3). The website treats poppy:browser-sign-in as the
    // account's full access, so web.unscoped is true; the passkey gate still holds.
    web: { browser_session_endpoint: `${origin}${JOIN_PATH}`, unscoped: true },
    tasks: { endpoint: `${origin}${POPPY_PATHS.tasks}` },
    // Operations v3 on the API and MCP routes (slice B). No `endpoint` yet: the
    // website variant needs Poppy sessions and browser join (slice C).
    extensions: { operations: [{ version: OPERATIONS_VERSION }] },
  };
}

// How each action an agent may not do is described, and where the person does it.
// Declarative wording only (FR25, control P1).
const EXCLUDED_TASK_TEXT: Record<string, { task: string; instructions: string; path: string }> = {
  update_contact: {
    task: "Change the recovery email or phone",
    instructions:
      "The account holder changes the recovery email or phone on the website after signing in. Requests from automated assistants for this change are refused.",
    path: "/account/contact",
  },
};

// Tasks a declared agent is denied by the policy file, so the list can't drift
// from what the guard enforces.
export function excludedActions(policy: Policy): string[] {
  return Object.entries(policy.data.actions)
    .filter(([, row]) => row.declared_agent === "deny")
    .map(([action]) => action);
}

export function tasksResponse(origin: string, policy: Policy) {
  return {
    excluded_tasks: excludedActions(policy).map((action) => {
      const text = EXCLUDED_TASK_TEXT[action];
      if (!text) throw new Error(`No Poppy task text for excluded action ${action}`);
      return {
        task: text.task,
        alternative: {
          instructions: text.instructions,
          references: [{ type: "web", url: `${origin}${text.path}` }],
        },
      };
    }),
    feedback: { endpoint: `${origin}${POPPY_PATHS.feedback}` },
  };
}
