// MCP tools for the permit journey (spec section 10, FR31, controls M4, P1, P2).
// Every mutating tool calls the same hitlGuard as the web routes, with the OAuth
// client as tier A evidence, so the caller is always at least declared_agent.
// Descriptions say what each tool does and its risk, in neutral declarative words.
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { SessionRow } from "../auth/session";
import type { AppDb } from "../db/types";
import { hitlGuard } from "../hitl/guard";
import { GATED_MESSAGE, continueUrl, deniedBody, ticketInvalidBody } from "../hitl/response";
import { getTicket, type Ticket } from "../hitl/tickets";
import {
  JourneyError,
  attachDocument,
  createDraft,
  deleteApplication,
  getApplication,
  journeyState,
  listApplications,
  payFee,
  submitApplication,
  updateContact,
  updateDraft,
} from "../journey/service";
import { logEvent } from "../log";

export interface McpCaller {
  db: AppDb;
  request: Request;
  origin: string;
  userId: string;
  session: SessionRow;
  clientId: string;
  secret: string;
  mode: "enforce" | "observe";
  ttlSeconds: number;
}

const appId = z.string().describe("The application ID.");
const ticketArg = z
  .string()
  .optional()
  .describe("The approval ticket ID from an earlier requires_human_approval result.");

// Name, policy action (null for read-only tools) and description, checked by tests.
export const MCP_TOOLS = {
  list_applications: {
    action: null,
    description:
      "Lists the account's permit applications, optionally filtered by a search term. Read only.",
  },
  get_application: {
    action: null,
    description: "Returns one application with its details, documents and status. Read only.",
  },
  get_journey_state: {
    action: null,
    description:
      "Returns where an application is in the journey and which actions are available next. Read only.",
  },
  get_approval_status: {
    action: null,
    description:
      "Returns the state of an approval ticket (pending, approved, rejected, expired or consumed) and when it expires. Read only.",
  },
  create_draft: {
    action: "create_draft",
    description: "Starts a new draft application. Low risk.",
  },
  update_draft: {
    action: "update_draft",
    description:
      "Updates the event details of a draft: title, date (YYYY-MM-DD), expected attendance and location. Low risk.",
  },
  attach_document: {
    action: "attach_document",
    description:
      "Records a supporting document for a draft by file name, MIME type and size in bytes; no file content is stored. Low risk.",
  },
  submit_application: {
    action: "submit_application",
    description:
      "Submits a complete draft as a legal declaration. High risk: the account holder approves it with their passkey. Without an approved ticket the result has status requires_human_approval and a link for the account holder; once approved, the same call with hitl_ticket_id completes it.",
  },
  pay_fee: {
    action: "pay_fee",
    description:
      "Pays the mock 50 USD fee for a submitted application. High risk: the account holder approves it with their passkey, as for submit_application.",
  },
  update_contact: {
    action: "update_contact",
    description:
      "Changes the account's recovery email or phone. Critical risk: requests from automated assistants are refused; the account holder makes this change after signing in.",
  },
  delete_application: {
    action: "delete_application",
    description:
      "Deletes an application. High risk: the account holder approves it with their passkey, as for submit_application.",
  },
} as const;

type ToolName = keyof typeof MCP_TOOLS;

function result(body: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(body) }],
    structuredContent: body,
    isError,
  };
}

// The MCP form of the gated response (spec 10, FR32 tool_result mode).
export function gatedToolBody(ticket: Ticket, origin: string) {
  return {
    status: "requires_human_approval",
    action: ticket.action,
    ticket_id: ticket.id,
    continue_url: continueUrl(origin, ticket.id),
    message_for_user: GATED_MESSAGE,
    resume: {
      poll_tool: "get_approval_status",
      retry_with_argument: "hitl_ticket_id",
      expires_at: ticket.expiresAt.toISOString(),
    },
  };
}

function journeyFailure(err: unknown) {
  if (err instanceof JourneyError) return result({ error: err.code, message: err.message }, true);
  throw err;
}

// Arguments become the string body the approval hash covers, so the first call and
// the retry with hitl_ticket_id hash identically.
function toBody(args: Record<string, unknown>, ticket?: string) {
  const body: Record<string, string> = {};
  for (const [k, v] of Object.entries(args)) {
    if (k === "hitl_ticket_id" || v === undefined || v === null) continue;
    body[k] = typeof v === "string" ? v : JSON.stringify(v);
  }
  if (ticket) body.hitl_ticket = ticket;
  return body;
}

async function guarded(
  c: McpCaller,
  tool: ToolName,
  resourceId: string | null,
  body: Record<string, string>,
  run: () => Promise<Record<string, unknown>>,
) {
  const action = MCP_TOOLS[tool].action!;
  let g;
  try {
    g = await hitlGuard({
      db: c.db,
      request: c.request,
      route: "mcp",
      userId: c.userId,
      session: c.session,
      action,
      resourceId,
      body,
      secret: c.secret,
      mode: c.mode,
      ttlSeconds: c.ttlSeconds,
      mcp: { clientId: c.clientId, tool },
    });
  } catch (err) {
    return journeyFailure(err);
  }
  if (g.kind === "gated") return result(gatedToolBody(g.ticket, c.origin));
  if (g.kind === "denied") return result(deniedBody(action, g.reason), true);
  if (g.kind === "ticket_invalid") {
    return result(ticketInvalidBody(action, g.ticketId, g.reason), true);
  }
  try {
    const out = await run();
    await g.finish("executed");
    return result(out);
  } catch (err) {
    await g.finish("error", err instanceof JourneyError ? err.code : "exception");
    return journeyFailure(err);
  }
}

// Read-only tools aren't gated, but are logged so the console shows the run.
async function logged(c: McpCaller, tool: ToolName, run: () => Promise<Record<string, unknown>>) {
  try {
    const out = await run();
    await logEvent(c.db, {
      route: "mcp",
      method: "POST",
      pathOrTool: tool,
      userId: c.userId,
      sessionId: c.session.id,
      runId: c.session.runId,
      actorClass: "declared_agent",
      actorSignals: {
        tier: "A",
        facts: { protocolAgent: { source: "mcp_token", agent: c.clientId } },
      },
      policyDecision: "allow",
      outcome: "executed",
      userAgent: (c.request.headers.get("user-agent") ?? "").slice(0, 300),
    });
    return result(out);
  } catch (err) {
    return journeyFailure(err);
  }
}

export function buildMcpServer(c: McpCaller) {
  const server = new McpServer({ name: "demogov-permits", version: "0.1.0" });
  const tool = <S extends z.ZodRawShape>(
    name: ToolName,
    shape: S,
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<ReturnType<typeof result>>,
  ) =>
    server.registerTool(
      name,
      { description: MCP_TOOLS[name].description, inputSchema: z.object(shape) },
      handler as never,
    );

  tool("list_applications", { query: z.string().max(100).optional() }, ({ query }) =>
    logged(c, "list_applications", async () => ({
      applications: await listApplications(c.db, c.userId, query),
    })),
  );
  tool("get_application", { application_id: appId }, ({ application_id }) =>
    logged(c, "get_application", async () => ({
      application: await getApplication(c.db, c.userId, application_id),
    })),
  );
  tool("get_journey_state", { application_id: appId }, ({ application_id }) =>
    logged(c, "get_journey_state", async () => {
      const application = await getApplication(c.db, c.userId, application_id);
      return { status: application.status, ...journeyState(application) };
    }),
  );
  tool("get_approval_status", { ticket_id: z.string().max(100) }, ({ ticket_id }) =>
    logged(c, "get_approval_status", async () => {
      const t = await getTicket(c.db, ticket_id);
      if (!t || t.userId !== c.userId) return { ticket_id, state: "not_found" };
      return {
        ticket_id: t.id,
        action: t.action,
        state: t.state,
        reason: t.rejectReason,
        expires_at: t.expiresAt.toISOString(),
      };
    }),
  );

  tool("create_draft", { title: z.string().max(120).optional() }, (args) =>
    guarded(c, "create_draft", null, toBody(args), async () => ({
      application: await createDraft(c.db, c.userId, args.title),
    })),
  );
  tool(
    "update_draft",
    {
      application_id: appId,
      title: z.string().max(120).optional(),
      date: z.string().max(10).optional(),
      attendance: z.union([z.number(), z.string()]).optional(),
      location: z.string().max(200).optional(),
    },
    ({ application_id, ...fields }) =>
      guarded(c, "update_draft", application_id, toBody(fields), async () => ({
        application: await updateDraft(c.db, c.userId, application_id, fields),
      })),
  );
  tool(
    "attach_document",
    {
      application_id: appId,
      name: z.string().max(200),
      type: z.string().max(100),
      size: z.number().int(),
    },
    ({ application_id, ...meta }) =>
      guarded(c, "attach_document", application_id, toBody(meta), async () => ({
        application: await attachDocument(c.db, c.userId, application_id, meta),
      })),
  );
  tool(
    "submit_application",
    {
      application_id: appId,
      declaration: z
        .boolean()
        .describe("True confirms the information given is true and complete."),
      hitl_ticket_id: ticketArg,
    },
    ({ application_id, declaration, hitl_ticket_id }) =>
      guarded(
        c,
        "submit_application",
        application_id,
        toBody({ declaration: declaration ? "true" : "false" }, hitl_ticket_id),
        async () => ({ application: await submitApplication(c.db, c.userId, application_id) }),
      ),
  );
  tool(
    "pay_fee",
    { application_id: appId, hitl_ticket_id: ticketArg },
    ({ application_id, hitl_ticket_id }) =>
      guarded(c, "pay_fee", application_id, toBody({}, hitl_ticket_id), async () => ({
        application: await payFee(c.db, c.userId, application_id),
      })),
  );
  tool(
    "update_contact",
    {
      recovery_email: z.string().max(254).optional(),
      phone: z.string().max(20).optional(),
      hitl_ticket_id: ticketArg,
    },
    ({ recovery_email, phone, hitl_ticket_id }) => {
      const contact = { recoveryEmail: recovery_email, phone };
      return guarded(c, "update_contact", null, toBody(contact, hitl_ticket_id), async () => ({
        contact: await updateContact(c.db, c.userId, contact),
      }));
    },
  );
  tool(
    "delete_application",
    { application_id: appId, hitl_ticket_id: ticketArg },
    ({ application_id, hitl_ticket_id }) =>
      guarded(c, "delete_application", application_id, toBody({}, hitl_ticket_id), async () => {
        await deleteApplication(c.db, c.userId, application_id);
        return { deleted: application_id };
      }),
  );
  return server;
}
