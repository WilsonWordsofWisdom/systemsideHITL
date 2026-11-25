// J13 T16-T18 (FR42-FR44, controls PP1-PP4): Poppy discovery is absent in baseline
// runs and served with POPPY=on, without changing what MCP clients see; approvals in
// the Operations format still need the account holder's passkey.
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  DEMO,
  PASSWORD,
  addAuthenticator,
  enrolPasskey,
  removeAuthenticators,
  resetTicketLimits,
} from "./helpers";
import { startVariant, type Variant } from "./variant";

test.describe.configure({ mode: "serial" });
test.beforeEach(resetTicketLimits);

const POPPY_HEADERS = { "poppy-version": "1.0", "poppy-extensions": '"operations";v="3"' };

// The agent: a password session, calling the submit API directly.
async function agent(context: BrowserContext, origin: string) {
  const page = await context.newPage();
  await page.goto(`${origin}/login`);
  await page.getByLabel("Email address").fill(DEMO.email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText(`Signed in as ${DEMO.name}`).first()).toBeVisible();
  const csrf = (await page.locator('meta[name="csrf-token"]').getAttribute("content"))!;
  const base = { origin, "x-csrf-token": csrf };
  const created = await page.request
    .post(`${origin}/api/applications`, { headers: base, data: { title: "Poppy Picnic" } })
    .then((r) => r.json());
  const id = created.application.id as string;
  await page.request.post(`${origin}/api/applications/${id}/details`, {
    headers: base,
    data: { date: "2026-12-12", attendance: "80", location: "Riverside Park" },
  });
  const submit = (headers: Record<string, string> = {}) =>
    page.request.post(`${origin}/api/applications/${id}/submit`, {
      headers: { ...base, ...headers },
      data: { declaration: "on" },
    });
  return { page, id, submit };
}

const approvalHeader = (op: { operation_id: string; revision: string }, approver = "user") =>
  `operation_id="${op.operation_id}", revision="${op.revision}", approver="${approver}"`;

test("Poppy routes are absent in baseline runs; OAuth metadata unchanged", async ({ request }) => {
  expect((await request.get("/.well-known/poppy.json")).status()).toBe(404);
  expect((await request.get("/api/poppy/tasks")).status()).toBe(404);
  expect(
    (await request.post("/api/poppy/feedback", { data: { task: "x", description: "y" } })).status(),
  ).toBe(404);
  const root = await request.get("/.well-known/oauth-protected-resource");
  expect(root.status()).toBe(200);
  expect((await root.json()).resource).toMatch(/\/mcp$/);
});

test.describe("variant: POPPY=on", () => {
  let variant: Variant;
  test.beforeAll(async () => {
    variant = await startVariant(3107, { POPPY: "on" });
  });
  test.afterAll(async () => variant.stop());

  test("discovery, tasks and feedback work; /mcp still has its metadata", async ({ request }) => {
    const o = variant.origin;
    const doc = await request.get(`${o}/.well-known/poppy.json`);
    expect(doc.status()).toBe(200);
    expect(await doc.json()).toMatchObject({
      protocol_version: "1.0",
      organization: { domain: "localhost:3107" },
      web: {},
      tasks: { endpoint: `${o}/api/poppy/tasks` },
    });

    expect((await request.get(`${o}/.well-known/oauth-protected-resource`)).status()).toBe(404);
    const mcp = await request.get(`${o}/.well-known/oauth-protected-resource/mcp`);
    expect(mcp.status()).toBe(200);
    expect((await mcp.json()).resource).toBe(`${o}/mcp`);
    // The /mcp challenge still points clients at the /mcp metadata.
    const challenge = (await request.post(`${o}/mcp`, { data: {} })).headers()["www-authenticate"];
    expect(challenge).toContain(`${o}/.well-known/oauth-protected-resource/mcp`);

    const tasks = await request.get(`${o}/api/poppy/tasks`, {
      headers: { "poppy-version": "1.0" },
    });
    expect(tasks.status()).toBe(200);
    expect((await tasks.json()).excluded_tasks.map((t: { task: string }) => t.task)).toEqual([
      "Change the recovery email or phone",
    ]);

    const feedback = await request.post(`${o}/api/poppy/feedback`, {
      headers: { "poppy-version": "1.0", "x-forwarded-for": "192.0.2.77" },
      data: { task: "Change the recovery email", description: "Refused for assistants." },
    });
    expect(feedback.status()).toBe(202);
  });

  test("T17, T18: the agent's approval alone is declined; after the passkey it runs once", async ({
    browser,
  }) => {
    const o = variant.origin;
    const phoneContext = await browser.newContext();
    const phone: Page = await phoneContext.newPage();
    await addAuthenticator(phone);
    await enrolPasskey(phone);
    const botContext = await browser.newContext();
    const bot = await agent(botContext, o);

    // Gated: 403 approval_required with the operation, plus our own fields.
    const gated = await bot.submit(POPPY_HEADERS);
    expect(gated.status()).toBe(403);
    const first = await gated.json();
    expect(first).toMatchObject({
      error: "approval_required",
      status: "requires_human_approval",
      operation: { terms: { account_holder_passkey_approval: "required" } },
    });
    expect(first.operation.operation_id).toBe(first.ticket_id);

    // T18: the agent approves on its own word. Declined; nothing submitted.
    const declined = await bot.submit({
      ...POPPY_HEADERS,
      "poppy-approval": approvalHeader(first.operation, "agent"),
    });
    expect(declined.status()).toBe(403);
    expect(await declined.json()).toMatchObject({
      error: "approval_declined",
      alternative: { references: [{ type: "web", url: first.continue_url }] },
    });

    // The account holder approves with a passkey.
    await phone.goto(first.continue_url);
    await phone.getByRole("button", { name: "Approve with passkey" }).click();
    await expect(phone.getByRole("main").getByRole("status")).toContainText("Approved");

    // The old revision is replaced; the new one says the passkey approval is given.
    const replaced = await bot.submit({
      ...POPPY_HEADERS,
      "poppy-approval": approvalHeader(first.operation),
    });
    expect(replaced.status()).toBe(403);
    const second = (await replaced.json()).operation;
    expect(second.operation_id).toBe(first.operation.operation_id);
    expect(second.revision).not.toBe(first.operation.revision);
    expect(second.terms.account_holder_passkey_approval).toBe("given");

    // T17: the approval of the current revision runs, exactly once.
    const done = await bot.submit({ ...POPPY_HEADERS, "poppy-approval": approvalHeader(second) });
    expect(done.status()).toBe(200);
    const again = await bot.submit({ ...POPPY_HEADERS, "poppy-approval": approvalHeader(second) });
    expect(again.status()).toBe(200);
    expect(await again.json()).toEqual({ operation_id: second.operation_id, status: "performed" });

    await removeAuthenticators();
    await phoneContext.close();
    await botContext.close();
  });

  test("requests that don't declare the extension get today's response", async ({ browser }) => {
    const context = await browser.newContext();
    const bot = await agent(context, variant.origin);
    const res = await bot.submit({ "poppy-version": "1.0" });
    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(body.status).toBe("requires_human_approval");
    expect(body.operation).toBeUndefined();
    expect(res.headers()["www-authenticate"]).toContain("insufficient_user_authentication");
    await context.close();
  });
});
