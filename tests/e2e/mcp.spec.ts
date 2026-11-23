// The /mcp endpoint end to end (FR29, FR31, FR32, FR34, controls M1, M4, M6, M7,
// T3): bearer challenges, both protocol revisions with a real OAuth token, a gated
// submit approved with a passkey, URL elicitation on a variant server, and the run
// and client capabilities in the console.
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
import { startVariant } from "./variant";

test.describe.configure({ mode: "serial" });
test.beforeEach(resetTicketLimits);
test.afterEach(removeAuthenticators);

async function connect(
  token: string,
  era: "modern" | "legacy",
  run = "r-mcp-e2e",
  { origin = ORIGIN, capabilities = {} }: { origin?: string; capabilities?: object } = {},
) {
  const client = new Client(
    { name: "e2e-agent", version: "1.0.0" },
    {
      capabilities,
      ...(era === "modern"
        ? { versionNegotiation: { mode: { pin: "2026-07-28" } } }
        : { supportedProtocolVersions: ["2025-11-25"] }),
    },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${origin}/mcp?run=${run}`), {
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

async function draft(client: Client, title: string) {
  const created = structured(await client.callTool({ name: "create_draft", arguments: { title } }));
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

test("MCP_GATE_MODE=elicitation asks for the approval URL on both revisions and logs capabilities", async ({
  page,
  browser,
}) => {
  const variant = await startVariant(3104, { MCP_GATE_MODE: "elicitation" });
  const run = "r-mcp-elicit";
  const caps = { capabilities: { elicitation: { url: {} } }, origin: variant.origin };
  const submit = (id: string, hitl_ticket_id?: string) => ({
    name: "submit_application",
    arguments: {
      application_id: id,
      declaration: true,
      ...(hitl_ticket_id ? { hitl_ticket_id } : {}),
    },
  });
  try {
    const { token } = await mcpToken(page, "E2E elicitation agent", variant.origin);
    const phoneContext = await browser.newContext();
    const phone = await phoneContext.newPage();
    await addAuthenticator(phone);
    await enrolPasskey(phone);

    // 2026-07-28: the client opens the URL (here, the phone approves) and retries.
    const modern = await connect(token, "modern", run, caps);
    const id1 = await draft(modern, "Elicitation picnic");
    const urls: string[] = [];
    modern.setRequestHandler("elicitation/create", async (req) => {
      const url = (req.params as { url: string }).url;
      urls.push(url);
      await approveWithPasskey(phone, url.split("/").pop()!);
      return { action: "accept" };
    });
    const done = await modern.callTool(submit(id1));
    expect(structured(done)).toMatchObject({ application: { status: "submitted" } });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(new RegExp(`^${variant.origin}/approve/hitl_`));
    await modern.close();

    // 2025-11-25: -32042 with the ticket as elicitationId, using the capabilities
    // declared in initialize; the retry carries hitl_ticket_id.
    const legacy = await connect(token, "legacy", run, caps);
    const id2 = await draft(legacy, "Legacy elicitation picnic");
    const err = (await legacy.callTool(submit(id2)).catch((e: unknown) => e)) as {
      code?: number;
      data?: { elicitations?: { elicitationId: string; url: string }[] };
    };
    expect(err.code).toBe(-32042);
    const { elicitationId, url } = err.data!.elicitations![0];
    expect(url).toBe(`${variant.origin}/approve/${elicitationId}`);
    await approveWithPasskey(phone, elicitationId);
    const retried = await legacy.callTool(submit(id2, elicitationId));
    expect(structured(retried)).toMatchObject({ application: { status: "submitted" } });
    await legacy.close();

    // A client that didn't declare URL elicitation gets the tool_result response.
    const plain = await connect(token, "legacy", run, { origin: variant.origin });
    const gated = await plain.callTool(submit(await draft(plain, "Plain picnic")));
    expect(structured(gated)).toMatchObject({ status: "requires_human_approval" });
    await plain.close();
    await phoneContext.close();

    // The console shows each client's revision and URL elicitation support (M6).
    const admin = await (await browser.newContext()).newPage();
    await admin.goto("/console");
    await admin.getByLabel("Admin secret").fill(E2E_ADMIN_SECRET);
    await admin.getByRole("button", { name: "Sign in to the console" }).click();
    await admin.goto(`/console?run=${run}`);
    const table = admin.getByRole("table");
    await expect(table).toContainText("initialize");
    await expect(table).toContainText("MCP 2026-07-28 · URL elicitation");
    await expect(table).toContainText("MCP 2025-11-25 · URL elicitation");
    await expect(table).toContainText("MCP 2025-11-25 · no URL elicitation");
    await admin.context().close();
  } finally {
    await variant.stop();
  }
});
