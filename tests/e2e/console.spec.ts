// The observability console (J11; FR16, FR39, FR40, controls L2, L4, C6).
import { expect, request, test, type Browser, type Page } from "@playwright/test";
import { E2E_ADMIN_SECRET } from "./env";
import {
  DEMO,
  ORIGIN,
  expectSignedIn,
  handoffTicket,
  signIn,
  testDb,
  resetTicketLimits,
  addAuthenticator,
  approveWithPasskey,
  enrolPasskey,
  removeAuthenticators,
} from "./helpers";
import { startVariant } from "./variant";

test.describe.configure({ mode: "serial" });
test.beforeEach(resetTicketLimits);
test.afterEach(removeAuthenticators);

async function adminPage(browser: Browser, origin = ORIGIN) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${origin}/console`);
  await page.getByLabel("Admin secret").fill(E2E_ADMIN_SECRET);
  await page.getByRole("button", { name: "Sign in to the console" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Console");
  return page;
}

// The agent's browser, started from a run link (FR40), submitting its own fresh
// draft so tests don't depend on each other's applications.
async function botRun(browser: Browser, run: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`/?run=${run}`);
  await signIn(page, DEMO.email);
  await expectSignedIn(page, DEMO.name);
  const csrf = (await page.locator('meta[name="csrf-token"]').getAttribute("content"))!;
  const headers = { origin: ORIGIN, "x-csrf-token": csrf };
  const created = await page.request
    .post("/api/applications", { headers, data: { title: `Run ${run} picnic` } })
    .then((r) => r.json());
  const id = created.application.id as string;
  await page.request.post(`/api/applications/${id}/details`, {
    headers,
    data: { date: "2026-12-12", attendance: "80", location: "Riverside Park" },
  });
  await page.goto(`/apply/${id}/declare`);
  await page
    .getByLabel("I declare that the information I have given is true and complete.")
    .check();
  await page.getByRole("button", { name: "Submit application" }).click();
  const ticket = await handoffTicket(page, "submit_application");
  return { page, id, ticket, close: () => context.close() };
}

const table = (page: Page) => page.getByRole("table");

test("the console asks for the admin secret and is not indexed or linked", async ({ page }) => {
  const res = await page.goto("/console");
  expect(res?.headers()["x-robots-tag"]).toContain("noindex");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Console sign-in");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  await page.goto("/");
  await expect(page.locator('a[href*="console"]')).toHaveCount(0);
});

test("a signed-in demo user can't open the console or its exports", async ({ page }) => {
  await signIn(page, DEMO.email);
  await expectSignedIn(page, DEMO.name);
  await page.goto("/console");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Console sign-in");
  const exported = await page.request.get("/api/console/export?format=json");
  expect(exported.status()).toBe(403);
});

test("a run's requests appear with their signals, filters and ground truth (FR39, FR40)", async ({
  browser,
}) => {
  const bot = await botRun(browser, "r42");
  const other = await botRun(browser, "r43");
  const admin = await adminPage(browser);

  await admin.goto("/console?run=r42");
  const rows = table(admin).getByRole("row");
  await expect(table(admin)).toContainText("weights draft-1");
  const gated = rows.filter({ hasText: "submit_application" }).first();
  await expect(gated).toContainText("suspected");
  await expect(gated).toContainText("gate");
  await expect(gated).toContainText("gated");
  await expect(gated).toContainText(bot.ticket.slice(0, 12));
  await expect(table(admin)).not.toContainText(other.ticket.slice(0, 12));

  // Ground truth, shown beside the classifier output.
  await admin.getByLabel("Agent label", { exact: true }).last().fill("ChatGPT agent, web");
  await admin.getByLabel("Who was acting").selectOption("agent");
  await admin.getByRole("button", { name: "Save ground truth" }).click();
  await expect(table(admin)).toContainText("ground truth: ChatGPT agent, web (agent)");

  // Filter by agent label: only the labelled run's rows.
  await admin.goto("/console?agent=ChatGPT%20agent%2C%20web");
  await expect(table(admin)).toContainText(bot.ticket.slice(0, 12));
  await expect(table(admin)).not.toContainText(other.ticket.slice(0, 12));

  // Filter by session: the other bot's session only.
  const sql = testDb();
  let otherSession: string;
  try {
    const [t] =
      await sql`select requesting_session_id from hitl_tickets where id = ${other.ticket}`;
    otherSession = t.requesting_session_id;
  } finally {
    await sql.end();
  }
  await admin.goto(`/console?session=${otherSession.slice(0, 12)}`);
  await expect(table(admin)).toContainText(other.ticket.slice(0, 12));
  await expect(table(admin)).not.toContainText(bot.ticket.slice(0, 12));

  // Exports of the run: the rows shown, hashed IPs, no secrets (L4).
  const json = await admin.request.get("/api/console/export?format=json&run=r42");
  expect(json.status()).toBe(200);
  const data = (await json.json()) as { run_id: string; ip_hash: string; ticket_id: string }[];
  expect(data.length).toBeGreaterThan(0);
  expect(data.every((r) => r.run_id === "r42")).toBe(true);
  expect(data.some((r) => r.ticket_id === bot.ticket)).toBe(true);
  const csv = await (await admin.request.get("/api/console/export?format=csv&run=r42")).text();
  expect(csv.split("\r\n")[0]).toContain("ip_hash");
  expect(csv).toContain(bot.ticket);
  for (const text of [JSON.stringify(data), csv]) {
    expect(text).not.toMatch(/127\.0\.0\.1|::1/);
    expect(text).not.toContain("e2e-session-secret");
    expect(text).not.toContain(E2E_ADMIN_SECRET);
    expect(text).not.toContain("e2e-demo-password");
  }

  await bot.close();
  await other.close();
  await admin.context().close();
});

test("the policy is shown read-only", async ({ browser }) => {
  const admin = await adminPage(browser);
  await admin.goto("/console/policy");
  await expect(admin.getByRole("heading", { level: 1 })).toHaveText("Policy");
  await expect(admin.getByRole("main")).toContainText("submit_application:");
  await expect(admin.getByRole("main").locator("form, textarea, input")).toHaveCount(0);
  await admin.context().close();
});

test("observe mode shows a banner in the console (C6)", async ({ browser }) => {
  const variant = await startVariant(3103, { HITL_MODE: "observe", HITL_ALLOW_OBSERVE: "true" });
  try {
    const admin = await adminPage(browser, variant.origin);
    await expect(admin.getByRole("status").first()).toContainText(
      "Observe mode: decisions are logged but nothing is blocked.",
    );
    await admin.context().close();
  } finally {
    await variant.stop();
  }
});

test("the ticket and session timelines show who asked, who approved and a handover (FR39)", async ({
  browser,
}) => {
  const bot = await botRun(browser, "r50");
  // The account holder approves on their own device with a passkey.
  const phoneContext = await browser.newContext();
  const phone = await phoneContext.newPage();
  await addAuthenticator(phone);
  await enrolPasskey(phone);
  await approveWithPasskey(phone, bot.ticket);
  const csrf = (await bot.page.locator('meta[name="csrf-token"]').getAttribute("content"))!;
  const retry = await bot.page.request.post(`/api/applications/${bot.id}/submit`, {
    headers: { origin: ORIGIN, "x-csrf-token": csrf, "x-hitl-ticket": bot.ticket },
    data: { declaration: "on" },
  });
  expect(retry.status()).toBe(200);

  // Then the bot's cookie is used from a script: a probable handover.
  const token = (await bot.page.context().cookies()).find((c) => c.name === "dg_session")!.value;
  const script = await request.newContext({
    baseURL: ORIGIN,
    userAgent: "python-requests/2.32",
    extraHTTPHeaders: { cookie: `dg_session=${token}` },
  });
  await script.post("/api/applications", {
    headers: { origin: ORIGIN, "x-csrf-token": csrf },
    data: { title: "From a script" },
  });
  await script.dispose();

  const admin = await adminPage(browser);
  await admin.goto("/console?run=r50");
  await table(admin)
    .getByRole("link", { name: bot.ticket.slice(0, 12) })
    .first()
    .click();
  const panel = admin.getByRole("complementary", { name: "Details" });
  const ticketTab = panel.getByRole("tabpanel", { name: "Ticket" });
  await expect(ticketTab).toContainText("Created");
  await expect(ticketTab).toContainText("Requested by suspected_agent");
  await expect(ticketTab).toContainText("Approved");
  await expect(ticketTab).toContainText("Passkey (UV)");
  await expect(ticketTab).toContainText("to approve");
  await expect(ticketTab).toContainText("Consumed");
  await expect(ticketTab).toContainText("executed 1 time(s)");

  await panel.getByRole("tab", { name: "Session" }).click();
  const sessionTab = panel.getByRole("tabpanel", { name: "Session" });
  await expect(sessionTab).toContainText("Login class");
  await expect(sessionTab).toContainText("probable handover");
  await expect(sessionTab).toContainText("client context changed");

  await bot.close();
  await phoneContext.close();
  await admin.context().close();
});

test("new requests appear in the open console without a reload", async ({ browser }) => {
  const admin = await adminPage(browser);
  await admin.goto("/console?run=r70");
  await expect(table(admin)).toContainText("No requests in this run yet.");
  const bot = await botRun(browser, "r70");
  await expect(table(admin)).toContainText(bot.ticket.slice(0, 12), { timeout: 10_000 });
  await bot.close();
  await admin.context().close();
});

test("Reset demo data clears logs, tickets and sessions and restores the seed (L3)", async ({
  browser,
}) => {
  const bot = await botRun(browser, "r60");
  const admin = await adminPage(browser);
  await admin.getByRole("button", { name: "Reset demo data" }).click();
  const dialog = admin.getByRole("dialog", { name: "Reset demo data?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Yes, reset demo data" }).click();
  await expect(admin.getByRole("main").getByRole("status").first()).toContainText(
    "Demo data reset",
  );

  // Only the reset itself is left in the log.
  const rows = table(admin).locator("tbody tr");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("console_reset");

  // The bot was signed out, and the seed applications are back.
  await bot.page.goto("/applications");
  await expect(bot.page).toHaveURL(/\/login/);
  const sql = testDb();
  try {
    const apps = await sql`select title, status from applications order by title`;
    expect(apps.map((a) => a.title)).toEqual([
      "Autumn Craft Market",
      "Neighbourhood Garage Sale",
      "Summer Street Fair",
      "Winter Lights Walk",
    ]);
    const [{ n }] = await sql`select count(*)::int as n from hitl_tickets`;
    expect(n).toBe(0);
  } finally {
    await sql.end();
  }
  await bot.close();
  await admin.context().close();
});

// Last in this file: it locks console sign-in from this address for 10 minutes.
test("wrong admin secrets are rate limited (L2)", async ({ page }) => {
  for (let i = 0; i < 5; i++) {
    await page.goto("/console");
    await page.getByLabel("Admin secret").fill(`wrong-secret-${i}`);
    await page.getByRole("button", { name: "Sign in to the console" }).click();
  }
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Too many attempts");
  // Even the right secret is refused while locked.
  await page.getByLabel("Admin secret").fill(E2E_ADMIN_SECRET);
  await page.getByRole("button", { name: "Sign in to the console" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Too many attempts");

  const sql = testDb();
  try {
    await sql`delete from rate_limits where key like 'admin:%'`;
  } finally {
    await sql.end();
  }
});
