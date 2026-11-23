// The handoff panel and its variants (J02 web handoff cases; FR24, FR26, FR27):
// QR code, countdown, live status over SSE with a polling fallback, Continue,
// auto-resume, redirect mode and the gate status flag.
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import {
  DEMO,
  ORIGIN,
  PASSWORD,
  addAuthenticator,
  removeAuthenticators,
  enrolPasskey,
  handoffTicket,
  testDb,
  resetTicketLimits,
} from "./helpers";
import { startVariant, type Variant } from "./variant";

test.describe.configure({ mode: "serial" });
test.beforeEach(resetTicketLimits);

// The account holder's phone: its own passkey, used to approve every request.
let phoneContext: BrowserContext;
let phone: Page;

test.beforeAll(async ({ browser }) => {
  phoneContext = await browser.newContext();
  phone = await phoneContext.newPage();
  await addAuthenticator(phone);
  await enrolPasskey(phone);
});
test.afterAll(async () => {
  await removeAuthenticators();
  await phoneContext.close();
});

async function approveOnPhone(origin: string, ticket: string) {
  await phone.goto(`${origin}/approve/${ticket}`);
  await phone.getByRole("button", { name: "Approve with passkey" }).click();
  await expect(phone.getByRole("main").getByRole("status")).toContainText("Approved");
}

// The agent's browser: password session, no authenticator.
async function bot(browser: Browser, origin = ORIGIN) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${origin}/login`);
  await page.getByLabel("Email address").fill(DEMO.email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText(`Signed in as ${DEMO.name}`).first()).toBeVisible();
  return { context, page };
}

async function freshDraft(page: Page, origin = ORIGIN) {
  const csrf = (await page.locator('meta[name="csrf-token"]').getAttribute("content"))!;
  const headers = { origin, "x-csrf-token": csrf };
  const created = await page.request
    .post(`${origin}/api/applications`, { headers, data: { title: "Riverside Picnic" } })
    .then((r) => r.json());
  const id = created.application.id as string;
  await page.request.post(`${origin}/api/applications/${id}/details`, {
    headers,
    data: { date: "2026-12-12", attendance: "80", location: "Riverside Park" },
  });
  return { id, csrf };
}

async function submitForm(page: Page, id: string, origin = ORIGIN) {
  await page.goto(`${origin}/apply/${id}/declare`);
  await page
    .getByLabel("I declare that the information I have given is true and complete.")
    .check();
  await page.getByRole("button", { name: "Submit application" }).click();
}

const appStatus = async (page: Page, id: string, origin = ORIGIN) =>
  (await page.request.get(`${origin}/api/applications/${id}`).then((r) => r.json())).application
    .status;

// Times the guard let the action run on this ticket (the approval itself is logged too).
async function submissionsLogged(ticket: string) {
  const sql = testDb();
  try {
    const [row] = await sql`select count(*)::int as n from request_log
      where ticket_id = ${ticket} and outcome = 'executed' and reason = 'ticket_consumed'`;
    return row.n as number;
  } finally {
    await sql.end();
  }
}

test("panel: QR code, countdown, live approval, and Continue submits once (FR26, FR27)", async ({
  browser,
}) => {
  const { context, page } = await bot(browser);
  const { id } = await freshDraft(page);
  await submitForm(page, id);
  const ticket = await handoffTicket(page, "submit_application");
  const panel = page.getByRole("main").getByRole("alert");
  await expect(panel.getByRole("img", { name: "QR code for the approval link" })).toBeVisible();
  await expect(panel).toContainText(/Expires in \d+:\d\d/);
  await expect(panel).toContainText("This page updates automatically");

  await approveOnPhone(ORIGIN, ticket);
  // The bot's page updates without a reload, and nothing is submitted yet.
  await expect(page.getByRole("main").getByRole("status")).toContainText("Approved: continue", {
    timeout: 10_000,
  });
  expect(await appStatus(page, id)).toBe("draft");

  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(new RegExp(`/apply/${id}/pay$`));
  expect(await appStatus(page, id)).toBe("submitted");
  expect(await submissionsLogged(ticket)).toBe(1);
  await context.close();
});

test("the status falls back to polling when the event stream fails", async ({ browser }) => {
  const { context, page } = await bot(browser);
  await page.route("**/events", (route) => route.abort());
  const { id } = await freshDraft(page);
  await submitForm(page, id);
  const ticket = await handoffTicket(page, "submit_application");
  await approveOnPhone(ORIGIN, ticket);
  await expect(page.getByRole("main").getByRole("status")).toContainText("Approved: continue", {
    timeout: 10_000,
  });
  await context.close();
});

test("a declined request offers Submit again", async ({ browser }) => {
  const { context, page } = await bot(browser);
  const { id } = await freshDraft(page);
  await submitForm(page, id);
  const ticket = await handoffTicket(page, "submit_application");
  await phone.goto(`${ORIGIN}/approve/${ticket}`);
  await phone.getByRole("button", { name: "Decline" }).click();
  await expect(phone.getByRole("main").getByRole("status")).toContainText("You declined");

  await expect(page.getByRole("main").getByRole("status")).toContainText(
    "The account holder declined this request",
    { timeout: 10_000 },
  );
  await page.getByRole("link", { name: "Submit again" }).click();
  await expect(page.getByRole("button", { name: "Submit application" })).toBeVisible();
  await context.close();
});

test.describe("variant: HITL_HANDOFF_MODE=redirect, HITL_GATE_STATUS=202", () => {
  let variant: Variant;
  test.beforeAll(async () => {
    variant = await startVariant(3101, { HITL_HANDOFF_MODE: "redirect", HITL_GATE_STATUS: "202" });
  });
  test.afterAll(async () => variant.stop());

  test("a gated form redirects to the approval page; the API answers 202", async ({ browser }) => {
    const { context, page } = await bot(browser, variant.origin);
    const { id, csrf } = await freshDraft(page, variant.origin);
    await submitForm(page, id, variant.origin);
    await expect(page).toHaveURL(new RegExp(`^${variant.origin}/approve/hitl_`));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Approve this request?");

    const api = await page.request.post(`${variant.origin}/api/applications/${id}/submit`, {
      headers: { origin: variant.origin, "x-csrf-token": csrf },
      data: { declaration: "on" },
    });
    expect(api.status()).toBe(202);
    expect(await api.json()).toMatchObject({ status: "requires_human_approval" });
    await context.close();
  });
});

test.describe("variant: HITL_AUTORESUME=on, HITL_HANDOFF_MODE=both", () => {
  let variant: Variant;
  test.beforeAll(async () => {
    variant = await startVariant(3102, { HITL_AUTORESUME: "on", HITL_HANDOFF_MODE: "both" });
  });
  test.afterAll(async () => variant.stop());

  test("the page resubmits on its own once approved", async ({ browser }) => {
    const { context, page } = await bot(browser, variant.origin);
    const { id } = await freshDraft(page, variant.origin);
    await submitForm(page, id, variant.origin);
    const ticket = await handoffTicket(page, "submit_application", variant.origin);
    const panel = page.getByRole("main").getByRole("alert");
    await expect(panel.getByRole("link", { name: "Go to the approval page" })).toBeVisible();
    await expect(panel).toContainText("This page continues automatically");

    await approveOnPhone(variant.origin, ticket);
    await expect(page).toHaveURL(new RegExp(`/apply/${id}/pay$`), { timeout: 15_000 });
    expect(await appStatus(page, id, variant.origin)).toBe("submitted");
    expect(await submissionsLogged(ticket)).toBe(1);
    await context.close();
  });
});
