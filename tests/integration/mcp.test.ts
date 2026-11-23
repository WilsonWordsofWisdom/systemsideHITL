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
import { ensureMcpSession, mcpSessionId } from "@/lib/mcp/session";
import { MCP_TOOLS, buildMcpServer, type McpCaller } from "@/lib/mcp/tools";
import { DEMO_USER_ID } from "@/scripts/seed";
import { createTestDb } from "../helpers/db";

let db: AppDb;
let close: () => Promise<void>;
const SECRET = "s".repeat(40);
const ORIGIN = "https://hitltest.vercel.app";

beforeAll(async () => {
  ({ db, close } = await createTestDb({ seed: true }));
});
afterAll(async () => close());

async function caller(clientId: string): Promise<McpCaller> {
  const session = await ensureMcpSession(db, {
    secret: SECRET,
    clientId,
    clientName: `Client ${clientId}`,
    userId: DEMO_USER_ID,
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
    userId: DEMO_USER_ID,
    session,
    clientId,
    secret: SECRET,
    mode: "enforce",
    ttlSeconds: 600,
  };
}

async function connect(c: McpCaller, era: "modern" | "legacy") {
  const handler = createMcpHandler(() => buildMcpServer(c), { legacy: "stateless" });
  const client = new Client(
    { name: "test-agent", version: "1.0.0" },
    era === "modern"
      ? { versionNegotiation: { mode: { pin: "2026-07-28" } } }
      : { supportedProtocolVersions: ["2025-11-25"] },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
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
    const client = await connect(await caller(`mcp_list_${era}`), era);
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
    const c = await caller(`mcp_gate_${era}`);
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
    const owner = await connect(await caller(`mcp_owner_${era}`), era);
    const id = await freshDraft(owner);
    const g = body(
      await owner.callTool({
        name: "submit_application",
        arguments: { application_id: id, declaration: true },
      }),
    );
    await approveTicket(db, g.ticket_id!, { method: "passkey", meta: {} });

    const other = await connect(await caller(`mcp_other_${era}`), era);
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
    const client = await connect(await caller(`mcp_deny_${era}`), era);
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
    await client.close();
  });
});
