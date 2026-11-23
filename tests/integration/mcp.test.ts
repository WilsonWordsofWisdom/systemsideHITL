// MCP tools through the SDK client, on both protocol revisions (FR29, FR31,
// FR32 tool_result mode, controls M4, P1, C4): the same guard, tickets bound to
// the OAuth client plus user, every call logged.
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSession, validateSession } from "@/lib/auth/session";
import { findModelDirectedText } from "@/lib/content";
import { applications, hitlTickets, requestLog } from "@/lib/db/schema";
import type { AppDb } from "@/lib/db/types";
import { getPolicy } from "@/lib/hitl/policy";
import { approveTicket } from "@/lib/hitl/tickets";
import { legacyClientInfo } from "@/lib/mcp/request";
import { ensureMcpSession, mcpSessionId } from "@/lib/mcp/session";
import {
  MCP_TOOLS,
  buildMcpServer,
  logMcpRequest,
  stepScopedTools,
  type McpCaller,
} from "@/lib/mcp/tools";
import { DEMO_USER_ID, SECOND_USER_ID } from "@/scripts/seed";
import { createTestDb } from "../helpers/db";

let db: AppDb;
let close: () => Promise<void>;
const SECRET = "s".repeat(40);
const ORIGIN = "https://hitltest.vercel.app";

beforeAll(async () => {
  ({ db, close } = await createTestDb({ seed: true }));
});
afterAll(async () => close());

type Era = "modern" | "legacy";
const URL_ELICITATION = { elicitation: { url: {} } };

async function caller(
  clientId: string,
  opts: {
    era?: Era;
    gateMode?: McpCaller["gateMode"];
    capabilities?: Record<string, unknown>;
    userId?: string;
    visibleTools?: ReadonlySet<string> | null;
  } = {},
): Promise<McpCaller> {
  const era = opts.era ?? "modern";
  const userId = opts.userId ?? DEMO_USER_ID;
  const session = await ensureMcpSession(db, {
    secret: SECRET,
    clientId,
    clientName: `Client ${clientId}`,
    userId,
    tokenExpiresAt: new Date(Date.now() + 3600_000),
    runId: "r-mcp",
  });
  return {
    db,
    request: new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { "user-agent": "agent-sdk/1.0" },
    }),
    origin: ORIGIN,
    userId,
    session,
    clientId,
    secret: SECRET,
    mode: "enforce",
    ttlSeconds: 600,
    client: {
      era,
      protocolVersion: era === "modern" ? "2026-07-28" : "2025-11-25",
      capabilities: opts.capabilities ?? {},
      clientInfo: { name: "test-agent", version: "1.0.0" },
    },
    gateMode: opts.gateMode ?? "tool_result",
    visibleTools: opts.visibleTools ?? null,
  };
}

async function connect(
  c: McpCaller,
  era: Era,
  opts: {
    capabilities?: Record<string, unknown>;
    // Rewrites each outgoing JSON-RPC body (to tamper with a retry).
    rewrite?: (body: Record<string, unknown>) => Record<string, unknown>;
    // Sees each JSON response body.
    onResponse?: (body: Record<string, unknown>) => void;
  } = {},
) {
  const handler = createMcpHandler(() => buildMcpServer(c), { legacy: "stateless" });
  const client = new Client(
    { name: "test-agent", version: "1.0.0" },
    {
      capabilities: opts.capabilities ?? {},
      ...(era === "modern"
        ? { versionNegotiation: { mode: { pin: "2026-07-28" } } }
        : { supportedProtocolVersions: ["2025-11-25"] }),
    },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
      fetch: async (url, init) => {
        let req = new Request(url, init);
        if (opts.rewrite && typeof init?.body === "string") {
          req = new Request(url, {
            ...init,
            body: JSON.stringify(opts.rewrite(JSON.parse(init.body))),
          });
        }
        const res = await handler.fetch(req);
        if (opts.onResponse && res.headers.get("content-type")?.includes("application/json")) {
          opts.onResponse(await res.clone().json());
        }
        return res;
      },
    }),
  );
  expect(client.getProtocolEra()).toBe(era);
  return client;
}

type Body = Record<string, unknown> & { status?: string; ticket_id?: string };
const body = (r: { structuredContent?: unknown }) => r.structuredContent as Body;

async function freshDraft(client: Client) {
  const created = body(
    await client.callTool({ name: "create_draft", arguments: { title: "MCP picnic" } }),
  );
  const id = (created.application as { id: string }).id;
  await client.callTool({
    name: "update_draft",
    arguments: {
      application_id: id,
      date: "2026-12-12",
      attendance: 80,
      location: "Riverside Park",
    },
  });
  return id;
}

describe("tool definitions", () => {
  it("every mutating tool names a policy action; read-only tools are listed as read-only (C4)", () => {
    const policy = getPolicy();
    for (const [name, def] of Object.entries(MCP_TOOLS)) {
      if (def.action) expect(policy.data.actions[def.action], name).toBeDefined();
      else expect(policy.data.read_only, name).toContain(name);
    }
  });

  it("descriptions are declarative and free of model-directed text (P1)", () => {
    for (const [name, def] of Object.entries(MCP_TOOLS)) {
      expect(findModelDirectedText(def.description), name).toEqual([]);
      expect(def.description, name).toMatch(/Read only|Low risk|High risk|Critical risk/);
    }
  });
});

describe("MCP sessions", () => {
  it("one per client and user, never usable as a cookie", async () => {
    const a = await caller("mcp_a");
    expect(a.session.id).toBe(mcpSessionId(SECRET, "mcp_a", DEMO_USER_ID));
    expect(mcpSessionId(SECRET, "mcp_b", DEMO_USER_ID)).not.toBe(a.session.id);
    expect(a.session).toMatchObject({
      signinMethod: "oauth_mcp",
      loginActorClass: "declared_agent",
      runId: "r-mcp",
    });
    // Even someone who learned the row's preimage couldn't sign in with it as a cookie.
    expect(await validateSession(db, `mcp:${a.session.id}`)).toBeNull();
    const { token } = await createSession(db, { userId: DEMO_USER_ID, signinMethod: "oauth_mcp" });
    expect(await validateSession(db, token)).toBeNull();
  });
});

describe.each(["modern", "legacy"] as const)("tools on the %s era", (era) => {
  it("lists all tools and runs read-only and low-risk tools", async () => {
    const client = await connect(await caller(`mcp_list_${era}`, { era }), era);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(Object.keys(MCP_TOOLS).sort());
    const list = body(await client.callTool({ name: "list_applications", arguments: {} }));
    expect((list.applications as { title: string }[]).map((a) => a.title)).toContain(
      "Summer Street Fair",
    );
    const id = await freshDraft(client);
    const state = body(
      await client.callTool({ name: "get_journey_state", arguments: { application_id: id } }),
    );
    expect(state).toMatchObject({ status: "draft", step: "review" });
    await client.close();
  });

  it("gates submit with requires_human_approval (not an error), then completes once after approval", async () => {
    const c = await caller(`mcp_gate_${era}`, { era });
    const client = await connect(c, era);
    const id = await freshDraft(client);

    const gated = await client.callTool({
      name: "submit_application",
      arguments: { application_id: id, declaration: true },
    });
    expect(gated.isError).toBe(false);
    const g = body(gated);
    expect(g).toMatchObject({
      status: "requires_human_approval",
      action: "submit_application",
      resume: { poll_tool: "get_approval_status", retry_with_argument: "hitl_ticket_id" },
    });
    expect(g.continue_url).toBe(`${ORIGIN}/approve/${g.ticket_id}`);

    const [ticket] = await db.select().from(hitlTickets).where(eq(hitlTickets.id, g.ticket_id!));
    expect(ticket).toMatchObject({
      requestingSessionId: c.session.id,
      requestingClientId: c.clientId,
      state: "pending",
    });
    expect(ticket.requestedByActor).toMatchObject({ class: "declared_agent", tier: "A" });

    const status = body(
      await client.callTool({ name: "get_approval_status", arguments: { ticket_id: g.ticket_id } }),
    );
    expect(status).toMatchObject({ state: "pending", action: "submit_application" });

    await approveTicket(db, g.ticket_id!, { method: "passkey", meta: {} });
    const done = await client.callTool({
      name: "submit_application",
      arguments: { application_id: id, declaration: true, hitl_ticket_id: g.ticket_id },
    });
    expect(done.isError).toBe(false);
    expect(body(done)).toMatchObject({ application: { status: "submitted" } });

    const replay = await client.callTool({
      name: "submit_application",
      arguments: { application_id: id, declaration: true, hitl_ticket_id: g.ticket_id },
    });
    expect(replay.isError).toBe(true);
    expect(body(replay)).toMatchObject({ status: "ticket_invalid", reason: "consumed" });
    await client.close();
  });

  it("another client can't redeem the ticket (FR19)", async () => {
    const owner = await connect(await caller(`mcp_owner_${era}`, { era }), era);
    const id = await freshDraft(owner);
    const g = body(
      await owner.callTool({
        name: "submit_application",
        arguments: { application_id: id, declaration: true },
      }),
    );
    await approveTicket(db, g.ticket_id!, { method: "passkey", meta: {} });

    const other = await connect(await caller(`mcp_other_${era}`, { era }), era);
    const stolen = await other.callTool({
      name: "submit_application",
      arguments: { application_id: id, declaration: true, hitl_ticket_id: g.ticket_id },
    });
    expect(stolen.isError).toBe(true);
    expect(body(stolen)).toMatchObject({ reason: "wrong_session" });
    const [app] = await db.select().from(applications).where(eq(applications.id, id));
    expect(app.status).toBe("draft");
    await owner.close();
    await other.close();
  });

  it("refuses a contact change from an agent and reports journey errors as tool errors", async () => {
    const client = await connect(await caller(`mcp_deny_${era}`, { era }), era);
    const denied = await client.callTool({
      name: "update_contact",
      arguments: { phone: "+1 555 0100" },
    });
    expect(denied.isError).toBe(true);
    expect(body(denied)).toMatchObject({ status: "denied", action: "update_contact" });

    const missing = await client.callTool({
      name: "get_application",
      arguments: { application_id: "00000000-0000-4000-8000-000000000201" }, // another user's
    });
    expect(missing.isError).toBe(true);
    expect(body(missing)).toMatchObject({ error: "not_found" });
    await client.close();
  });
});

type UrlRequest = { mode?: string; url: string; message?: string; elicitationId?: string };
const ticketOf = (url: string) => url.split("/").pop()!;
const submitArgs = (id: string, hitl_ticket_id?: string) => ({
  name: "submit_application",
  arguments: {
    application_id: id,
    declaration: true,
    ...(hitl_ticket_id ? { hitl_ticket_id } : {}),
  },
});
const approve = (ticketId: string) => approveTicket(db, ticketId, { method: "passkey", meta: {} });
const appStatus = async (id: string) =>
  (await db.select().from(applications).where(eq(applications.id, id)))[0].status;

describe("elicitation gate mode on 2026-07-28 (FR32, M7)", () => {
  const opts = { gateMode: "elicitation" as const, capabilities: URL_ELICITATION };

  it("asks for a URL interaction, asks again while pending, and completes once on the retry", async () => {
    const client = await connect(await caller("mcp_elicit_modern", opts), "modern", opts);
    const id = await freshDraft(client);
    const asked: UrlRequest[] = [];
    client.setRequestHandler("elicitation/create", async (req) => {
      asked.push(req.params as UrlRequest);
      // The first time the user hasn't approved yet, so the server asks again.
      if (asked.length === 2) await approve(ticketOf(asked[1].url));
      return { action: "accept" };
    });
    const done = await client.callTool(submitArgs(id));
    expect(done.isError).toBe(false);
    expect(body(done)).toMatchObject({ application: { status: "submitted" } });
    expect(asked).toHaveLength(2);
    expect(asked[0]).toMatchObject({ mode: "url" });
    expect(asked[0].url).toMatch(new RegExp(`^${ORIGIN}/approve/hitl_`));
    expect(asked[1].url).toBe(asked[0].url);
    const [t] = await db
      .select()
      .from(hitlTickets)
      .where(eq(hitlTickets.id, ticketOf(asked[0].url)));
    expect(t.state).toBe("consumed");
    await client.close();
  });

  it("falls back to the tool_result response when the user declines the link", async () => {
    const client = await connect(await caller("mcp_elicit_decline", opts), "modern", opts);
    const id = await freshDraft(client);
    client.setRequestHandler("elicitation/create", async () => ({ action: "decline" }));
    const r = await client.callTool(submitArgs(id));
    expect(r.isError).toBe(false);
    expect(body(r)).toMatchObject({
      status: "requires_human_approval",
      action: "submit_application",
    });
    expect(await appStatus(id)).toBe("draft");
    await client.close();
  });

  it("refuses a tampered requestState, or one from another client's session", async () => {
    // Client A gets a sealed requestState for its ticket, which is then approved.
    let stateA: string | undefined;
    const a = await connect(await caller("mcp_state_a", opts), "modern", {
      ...opts,
      onResponse: (res) => {
        const r = res.result as { resultType?: string; requestState?: string } | undefined;
        if (r?.resultType === "input_required") stateA ??= r.requestState;
      },
    });
    const idA = await freshDraft(a);
    a.setRequestHandler("elicitation/create", async () => ({ action: "decline" }));
    const fallback = body(await a.callTool(submitArgs(idA)));
    await approve(fallback.ticket_id!);
    expect(stateA).toBeDefined();

    for (const [name, swap] of [
      ["mcp_state_b", () => stateA!],
      ["mcp_state_tamper", (s: string) => `${s.slice(0, -2)}xx`],
    ] as const) {
      const b = await connect(await caller(name, opts), "modern", {
        ...opts,
        rewrite: (req) => {
          const params = req.params as { requestState?: string } | undefined;
          if (params?.requestState) params.requestState = swap(params.requestState);
          return req;
        },
      });
      const idB = await freshDraft(b);
      b.setRequestHandler("elicitation/create", async () => ({ action: "accept" }));
      await expect(b.callTool(submitArgs(idB))).rejects.toThrow(/Invalid or expired requestState/);
      expect(await appStatus(idB)).toBe("draft");
      await b.close();
    }
    expect(await appStatus(idA)).toBe("draft");
    await a.close();
  });
});

describe("elicitation gate mode on 2025-11-25 (FR32, M7)", () => {
  it("returns -32042 with elicitationId = ticket ID; the retry with hitl_ticket_id executes once", async () => {
    const opts = {
      era: "legacy" as const,
      gateMode: "elicitation" as const,
      capabilities: URL_ELICITATION,
    };
    const client = await connect(await caller("mcp_elicit_legacy", opts), "legacy", opts);
    const id = await freshDraft(client);
    const elicited = async (args: ReturnType<typeof submitArgs>) => {
      const err = (await client.callTool(args).then(
        () => null,
        (e: unknown) => e,
      )) as { code?: number; data?: { elicitations?: UrlRequest[] } } | null;
      expect(err?.code).toBe(-32042);
      return err!.data!.elicitations![0];
    };
    const first = await elicited(submitArgs(id));
    expect(first).toMatchObject({ mode: "url", url: `${ORIGIN}/approve/${first.elicitationId}` });
    // Retrying before approval asks again for the same ticket.
    expect((await elicited(submitArgs(id, first.elicitationId))).elicitationId).toBe(
      first.elicitationId,
    );
    await approve(first.elicitationId!);
    const done = await client.callTool(submitArgs(id, first.elicitationId));
    expect(body(done)).toMatchObject({ application: { status: "submitted" } });
    const replay = await client.callTool(submitArgs(id, first.elicitationId));
    expect(body(replay)).toMatchObject({ status: "ticket_invalid", reason: "consumed" });
    await client.close();
  });
});

describe.each(["modern", "legacy"] as const)("elicitation mode on the %s era", (era) => {
  it("falls back to tool_result for a client without URL elicitation (FR32)", async () => {
    const c = await caller(`mcp_noelicit_${era}`, {
      era,
      gateMode: "elicitation",
      capabilities: { elicitation: { form: {} } },
    });
    const client = await connect(c, era);
    const r = await client.callTool(submitArgs(await freshDraft(client)));
    expect(r.isError).toBe(false);
    expect(body(r)).toMatchObject({ status: "requires_human_approval" });
    await client.close();
  });
});

describe("step-scoped tools (FR33, M5)", () => {
  const listed = async (clientId: string) => {
    const visibleTools = await stepScopedTools(db, SECOND_USER_ID);
    const client = await connect(
      await caller(clientId, { userId: SECOND_USER_ID, visibleTools }),
      "modern",
    );
    const names = (await client.listTools()).tools.map((t) => t.name);
    await client.close();
    return names;
  };

  it("lists what the journey state allows next, and a hidden tool still goes through the guard", async () => {
    // The second user has one paid application: nothing to submit or pay yet.
    const before = await listed("mcp_scope_1");
    expect(before).toEqual(expect.arrayContaining(["get_approval_status", "create_draft"]));
    expect(before).not.toContain("pay_fee");
    expect(before).not.toContain("submit_application");

    // Calling a hidden tool anyway reaches the guard and doesn't execute.
    const c = await caller("mcp_scope_2", { userId: SECOND_USER_ID });
    const client = await connect(c, "modern");
    const paid = "00000000-0000-4000-8000-000000000201";
    const hidden = await client.callTool({ name: "pay_fee", arguments: { application_id: paid } });
    expect(hidden.isError).toBe(true);
    const rows = await db.select().from(requestLog).where(eq(requestLog.sessionId, c.session.id));
    expect(rows.map((r) => r.pathOrTool)).toContain("pay_fee");

    // Once a draft is submitted, pay_fee is listed.
    const id = await freshDraft(client);
    const g = body(await client.callTool(submitArgs(id)));
    await approve(g.ticket_id!);
    await client.callTool(submitArgs(id, g.ticket_id));
    await client.close();
    expect(await listed("mcp_scope_3")).toContain("pay_fee");
  });
});

describe("client capabilities (FR34, M6)", () => {
  it("reads a legacy client's capabilities back from its latest initialize", async () => {
    const c = await caller("mcp_caps", { era: "legacy" });
    expect((await legacyClientInfo(db, c.session.id)).capabilities).toBeNull();
    await logMcpRequest(
      { ...c, client: { ...c.client, capabilities: { elicitation: {} } } },
      "initialize",
    );
    await new Promise((r) => setTimeout(r, 10));
    await logMcpRequest(
      { ...c, client: { ...c.client, capabilities: URL_ELICITATION } },
      "initialize",
    );
    expect(await legacyClientInfo(db, c.session.id)).toMatchObject({
      era: "legacy",
      protocolVersion: "2025-11-25",
      capabilities: URL_ELICITATION,
    });
  });
});

describe("logging", () => {
  it("logs every MCP tool call under the client's session with the tool name and run", async () => {
    const c = await caller("mcp_log");
    const client = await connect(c, "modern");
    await client.callTool({ name: "list_applications", arguments: {} });
    await client.callTool({ name: "update_contact", arguments: { phone: "+1 555 0100" } });
    const rows = await db.select().from(requestLog).where(eq(requestLog.sessionId, c.session.id));
    expect(rows.map((r) => [r.route, r.pathOrTool, r.actorClass, r.runId]).sort()).toEqual([
      ["mcp", "list_applications", "declared_agent", "r-mcp"],
      ["mcp", "update_contact", "declared_agent", "r-mcp"],
    ]);
    for (const r of rows) {
      expect(r.actorSignals.mcp, r.pathOrTool).toMatchObject({
        era: "modern",
        protocolVersion: "2026-07-28",
      });
    }
    await client.close();
  });
});
