// The phone page /device/[userId] (J05; FR10, FR20, FR22, controls W6, W11, T9):
// requests reach the phone live or by polling, are approved there with a passkey on
// an approval-only session, and the agent's session keeps running.
import { expect, test, type Browser, type Page } from "@playwright/test";
import {
  DEMO,
  ORIGIN,
  SECOND,
  addAuthenticator,
  clearLoginLock,
  enrolPasskey,
  expectSignedIn,
  handoffTicket,
  removeAuthenticators,
  resetTicketLimits,
  signIn,
  testDb,
} from "./helpers";

test.describe.configure({ mode: "serial" });
test.beforeEach(resetTicketLimits);
test.afterEach(removeAuthenticators);

const csrfOf = async (page: Page) =>
  (await page.locator('meta[name="csrf-token"]').getAttribute("content"))!;

// The agent's browser: a password session and no authenticator.
async function bot(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, DEMO.email);
  await expectSignedIn(page, DEMO.name);
  return page;
}

// The bot fills a fresh draft and submits the declaration form, reaching the gate.
async function gatedSubmit(page: Page, title: string) {
  const headers = { origin: ORIGIN, "x-csrf-token": await csrfOf(page) };
  const created = await page.request
    .post("/api/applications", { headers, data: { title } })
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
  return { id, ticket: await handoffTicket(page, "submit_application") };
}

const retry = async (page: Page, id: string, ticket: string) =>
  page.request.post(`/api/applications/${id}/submit`, {
    headers: { origin: ORIGIN, "x-csrf-token": await csrfOf(page), "x-hitl-ticket": ticket },
    data: { declaration: "on" },
  });

const stateOf = async (ticket: string) => {
  const sql = testDb();
  try {
    return (await sql`select state from hitl_tickets where id = ${ticket}`)[0].state as string;
  } finally {
    await sql.end();
  }
};

// The phone link from "Send to my phone instead" on the approval page.
async function phoneLink(page: Page, ticket: string) {
  await page.goto(`/approve/${ticket}`);
  await page.getByText("Send to my phone instead").click();
  const link = page.getByRole("link", { name: /\/device\// });
  await expect(link).toBeVisible();
  await expect(page.getByRole("img", { name: "QR code for the phone page" })).toBeVisible();
  return (await link.getAttribute("href"))!;
}

// The phone: its own passkey, signed out, then signed in on the phone page only.
async function phoneOn(browser: Browser, link: string) {
  const context = await browser.newContext();
  const phone = await context.newPage();
  await addAuthenticator(phone);
  await enrolPasskey(phone);
  await phone.getByRole("button", { name: "Sign out" }).click();
  await expect(phone).toHaveURL(/\/login/);
  await phone.goto(link);
  await expect(phone.getByRole("heading", { level: 1 })).toHaveText("Sign in to see requests");
  await phone.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(phone.getByText("DG Approvals")).toBeVisible();
  await expect(phone.getByRole("heading", { level: 1 })).not.toHaveText("Sign in to see requests");
  await expect(phone).toHaveURL(link);
  return phone;
}

const cards = (phone: Page) => phone.getByRole("list", { name: "Pending requests" });

test("T9: a request reaches the phone live, is approved there, and the agent resumes", async ({
  browser,
}) => {
  const agent = await bot(browser);
  const first = await gatedSubmit(agent, "Phone picnic");
  const link = await phoneLink(agent, first.ticket);
  expect(new URL(link).pathname).toBe("/device/00000000-0000-4000-8000-000000000001");

  const phone = await phoneOn(browser, link);
  // The phone signed in for approval only (W11).
  const cookies = await phone.context().cookies();
  expect(cookies.map((c) => c.name)).toContain("dg_approval");
  expect(cookies.map((c) => c.name)).not.toContain("dg_session");
  await expect(cards(phone)).toContainText('Submit the application "Phone picnic"');
  await expect(cards(phone)).toContainText("80 people");

  // A new request while the phone page is open arrives within 2 seconds.
  const second = await gatedSubmit(agent, "Live picnic");
  await expect(cards(phone)).toContainText('Submit the application "Live picnic"', {
    timeout: 2_500,
  });

  const card = cards(phone).getByRole("listitem").filter({ hasText: "Phone picnic" });
  await card.getByRole("button", { name: "Approve with passkey" }).click();
  await expect(phone.getByRole("region", { name: "Recent decisions" })).toContainText(
    'Approved · Submit the application "Phone picnic"',
  );
  expect(await stateOf(first.ticket)).toBe("approved");
  expect(await stateOf(second.ticket)).toBe("pending");

  // The agent's session survived, and its retry executes once.
  expect((await retry(agent, first.id, first.ticket)).status()).toBe(200);
  expect((await retry(agent, first.id, first.ticket)).status()).not.toBe(200);
  await agent.context().close();
  await phone.context().close();
});

test("the phone page falls back to polling when the live stream fails, and can decline", async ({
  browser,
}) => {
  const agent = await bot(browser);
  const first = await gatedSubmit(agent, "Polling picnic");
  const phone = await phoneOn(browser, await phoneLink(agent, first.ticket));
  await phone.route("**/api/device/events", (route) => route.abort());
  await phone.reload();
  await expect(phone.getByRole("status").filter({ hasText: "Reconnecting" })).toBeVisible();

  const second = await gatedSubmit(agent, "Polled picnic");
  await expect(cards(phone)).toContainText('Submit the application "Polled picnic"', {
    timeout: 8_000,
  });

  const card = cards(phone).getByRole("listitem").filter({ hasText: "Polled picnic" });
  await card.getByRole("button", { name: "Decline" }).click();
  await expect(phone.getByRole("region", { name: "Recent decisions" })).toContainText(
    'Declined · Submit the application "Polled picnic"',
  );
  expect(await stateOf(second.ticket)).toBe("rejected");
  await agent.context().close();
  await phone.context().close();
});

test("another account's phone page shows nothing", async ({ browser, page }) => {
  const agent = await bot(browser);
  const { ticket } = await gatedSubmit(agent, "Private picnic");
  const link = await phoneLink(agent, ticket);
  await agent.context().close();

  await clearLoginLock(SECOND.email);
  await signIn(page, SECOND.email);
  await expectSignedIn(page, SECOND.name);
  await page.goto(link);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "This page belongs to another account",
  );
  await expect(page.getByRole("main")).not.toContainText("Private picnic");
  expect((await page.request.get("/api/device/pending")).status()).toBe(200);
  expect((await page.request.get("/api/device/pending").then((r) => r.json())).pending).toEqual([]);
});
