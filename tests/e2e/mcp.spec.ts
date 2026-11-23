// The /mcp endpoint end to end (FR29, FR31, FR32, controls M1, M4, T3): bearer
// challenges, both protocol revisions with a real OAuth token, a gated submit
// approved with a passkey, and the run in the console.
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, test } from "@playwright/test";
import { E2E_ADMIN_SECRET } from "./env";
import {
  ORIGIN,
  addAuthenticator,
  approveWithPasskey,
  enrolPasskey,
  removeAuthenticators,
  resetTicketLimits,
} from "./helpers";
import { mcpToken } from "./oauth-helpers";

test.describe.configure({ mode: "serial" });
test.beforeEach(resetTicketLimits);
test.afterEach(removeAuthenticators);

async function connect(token: string, era: "modern" | "legacy", run = "r-mcp-e2e") {
  const client = new Client(
    { name: "e2e-agent", version: "1.0.0" },
    era === "modern"
      ? { versionNegotiation: { mode: { pin: "2026-07-28" } } }
      : { supportedProtocolVersions: ["2025-11-25"] },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp?run=${run}`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  expect(client.getProtocolEra()).toBe(era);
  return client;
}

const structured = (r: { structuredContent?: unknown }) =>
  r.structuredContent as Record<string, unknown> & { ticket_id?: string; status?: string };

test("without a valid token /mcp answers 401 with a pointer to the metadata (M1)", async ({
  request,
}) => {
  const ping = { jsonrpc: "2.0", id: 1, method: "tools/list" };
  const missing = await request.post("/mcp", { data: ping });
  expect(missing.status()).toBe(401);
  expect(missing.headers()["www-authenticate"]).toBe(
    `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
  );
  const bad = await request.post("/mcp", {
    data: ping,
    headers: { Authorization: "Bearer not-a-real-token" },
  });
  expect(bad.status()).toBe(401);
  expect(bad.headers()["www-authenticate"]).toContain('error="invalid_token"');
});

test("an MCP agent with a token lists tools on both revisions and is gated on submit", async ({
  page,
  browser,
}) => {
  const { token } = await mcpToken(page, "E2E MCP agent");

  for (const era of ["modern", "legacy"] as const) {
    const client = await connect(token, era);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("submit_application");
    expect(names).toContain("get_approval_status");
    await client.close();
  }

  const client = await connect(token, "modern");
  const created = structured(
    await client.callTool({ name: "create_draft", arguments: { title: "MCP e2e picnic" } }),
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
  const gated = await client.callTool({
    name: "submit_application",
    arguments: { application_id: id, declaration: true },
  });
  expect(gated.isError).toBe(false);
  const g = structured(gated);
  expect(g).toMatchObject({ status: "requires_human_approval", action: "submit_application" });

  // The account holder approves on their own device with a passkey.
  const phoneContext = await browser.newContext();
  const phone = await phoneContext.newPage();
  await addAuthenticator(phone);
  await enrolPasskey(phone);
  await approveWithPasskey(phone, g.ticket_id!);

  const status = structured(
    await client.callTool({ name: "get_approval_status", arguments: { ticket_id: g.ticket_id } }),
  );
  expect(status.state).toBe("approved");
  const done = await client.callTool({
    name: "submit_application",
    arguments: { application_id: id, declaration: true, hitl_ticket_id: g.ticket_id },
  });
  expect(done.isError).toBe(false);
  expect(structured(done)).toMatchObject({ application: { status: "submitted" } });

  // An agent can't change the recovery contact.
  const denied = await client.callTool({
    name: "update_contact",
    arguments: { phone: "+1 555 0100" },
  });
  expect(denied.isError).toBe(true);
  await client.close();

  // The run shows in the console with the MCP route and tool names.
  const admin = await (await browser.newContext()).newPage();
  await admin.goto("/console");
  await admin.getByLabel("Admin secret").fill(E2E_ADMIN_SECRET);
  await admin.getByRole("button", { name: "Sign in to the console" }).click();
  await admin.goto("/console?run=r-mcp-e2e");
  const table = admin.getByRole("table");
  await expect(table).toContainText("submit_application");
  await expect(table).toContainText("mcp");
  await expect(table).toContainText("declared");
  await phoneContext.close();
  await admin.context().close();
});
