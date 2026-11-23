// The observability console (J11; FR16, FR39, FR40, controls L2, L4, C6).
import { expect, test, type Browser, type Page } from "@playwright/test";
import { E2E_ADMIN_SECRET } from "./env";
import {
  DEMO,
  ORIGIN,
  expectSignedIn,
  handoffTicket,
  signIn,
  testDb,
  resetTicketLimits,
} from "./helpers";
import { startVariant } from "./variant";

test.describe.configure({ mode: "serial" });
test.beforeEach(resetTicketLimits);
const DRAFT = "00000000-0000-4000-8000-000000000103"; // Winter Lights Walk

async function adminPage(browser: Browser, origin = ORIGIN) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${origin}/console`);
  await page.getByLabel("Admin secret").fill(E2E_ADMIN_SECRET);
  await page.getByRole("button", { name: "Sign in to the console" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Console");
  return page;
}

// The agent's browser, started from a run link (FR40).
async function botRun(browser: Browser, run: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`/?run=${run}`);
  await signIn(page, DEMO.email);
  await expectSignedIn(page, DEMO.name);
  await page.goto(`/apply/${DRAFT}/declare`);
  await page
    .getByLabel("I declare that the information I have given is true and complete.")
    .check();
  await page.getByRole("button", { name: "Submit application" }).click();
  const ticket = await handoffTicket(page, "submit_application");
  return { page, ticket, close: () => context.close() };
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
