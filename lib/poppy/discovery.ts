// Poppy discovery (Poppy 1.0 sections 3 and 9; FR42, controls PP1, PP2).
//
// Slice A declares only what the site supports today: signed-out browsing (`web`)
// and the tasks endpoint. `auth` (issuer, scopes and scope hints) and `apis` are
// added in slice C, because the spec requires a listed issuer's metadata to name
// this domain and every listed API to accept Poppy sessions and enforce scopes.
import type { Policy } from "@/lib/hitl/policy";
import { POPPY_VERSION } from "./version";

export const POPPY_PATHS = {
  document: "/.well-known/poppy.json",
  tasks: "/api/poppy/tasks",
  feedback: "/api/poppy/feedback",
} as const;

export function poppyDocument(origin: string) {
  return {
    protocol_version: POPPY_VERSION,
    organization: {
      name: "DemoGov Permits (prototype)",
      // The host that serves the document, with its port when that isn't the default.
      domain: new URL(origin).host,
    },
    web: {},
    tasks: { endpoint: `${origin}${POPPY_PATHS.tasks}` },
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
