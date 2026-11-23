// Approval with a passkey (J02 approval and self-approval cases, J05 approval from
// another device; FR20, FR21, controls W1-W4, W11, T4, T7, T8, T9).
import { expect, test, type Page } from "@playwright/test";
import {
  DEMO,
  ORIGIN,
  SECOND,
  addAuthenticator,
  removeAuthenticators,
  clearLoginLock,
  enrolPasskey,
  expectSignedIn,
  handoffTicket,
  signIn,
  testDb,
} from "./helpers";

test.describe.configure({ mode: "serial" });
test.afterEach(removeAuthenticators);

const csrfOf = async (page: Page) =>
  (await page.locator('meta[name="csrf-token"]').getAttribute("content"))!;

// A fresh complete draft, so each test has its own resource.
async function freshDraft(page: Page) {
  const headers = { origin: ORIGIN, "x-csrf-token": await csrfOf(page) };
  const created = await page.request
    .post("/api/applications", { headers, data: { title: "Riverside Picnic" } })
    .then((r) => r.json());
  const id = created.application.id as string;
  const updated = await page.request.post(`/api/applications/${id}/details`, {
    headers,
    data: { date: "2026-12-12", attendance: "80", location: "Riverside Park" },
  });
  expect(updated.status()).toBe(200);
  return id;
}

// The bot submits the declaration form and gets the handoff panel.
async function gatedSubmit(page: Page) {
  const id = await freshDraft(page);
  await page.goto(`/apply/${id}/declare`);
  await page
    .getByLabel("I declare that the information I have given is true and complete.")
    .check();
  await page.getByRole("button", { name: "Submit application" }).click();
  const ticket = await handoffTicket(page, "submit_application");
  return { id, ticket };
}

const retry = async (page: Page, id: string, ticket: string) =>
  page.request.post(`/api/applications/${id}/submit`, {
    headers: { origin: ORIGIN, "x-csrf-token": await csrfOf(page), "x-hitl-ticket": ticket },
    data: { declaration: "on" },
  });

const state = async (page: Page, ticket: string) =>
  (await page.request.get(`/api/hitl/${ticket}`).then((r) => r.json())).state;

test("the account holder approves with a passkey and the retry executes once (T3)", async ({
  page,
}) => {
  await addAuthenticator(page);
  await enrolPasskey(page);
  const { id, ticket } = await gatedSubmit(page);

  // The preview comes from the ticket; a tampered query string changes nothing (T8).
  await page.goto(`/approve/${ticket}?title=Something+Else&attendance=9000`);
  await expect(page.getByText("You are approving on")).toContainText(new URL(ORIGIN).host);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Approve this request?");
  await expect(page.getByRole("main")).toContainText('Submit the application "Riverside Picnic"');
  await expect(page.getByRole("main")).toContainText("80 people");
  await expect(page.getByRole("main")).not.toContainText("Something Else");
  await expect(page.getByRole("main")).toContainText("Automated assistant (suspected)");

  await page.getByRole("button", { name: "Approve with passkey" }).click();
  await expect(page.getByRole("main").getByRole("status")).toContainText("Approved");
  expect(await state(page, ticket)).toBe("approved");

  const first = await retry(page, id, ticket);
  expect(first.status()).toBe(200);
  expect((await first.json()).application.status).toBe("submitted");
  const replay = await retry(page, id, ticket);
  expect(replay.status()).toBe(409);
  expect(await replay.json()).toMatchObject({ reason: "consumed" });

  const sql = testDb();
  try {
    const [row] = await sql`select outcome, reason from request_log
      where path_or_tool = ${`/api/hitl/${ticket}/approve`} order by ts desc limit 1`;
    expect(row).toMatchObject({ outcome: "executed", reason: "approved" });
    const [t] = await sql`select state, approval_method from hitl_tickets where id = ${ticket}`;
    expect(t).toMatchObject({ state: "consumed", approval_method: "passkey" });
  } finally {
    await sql.end();
  }
});

test("the bot can't approve its own ticket without the account holder's passkey (T4)", async ({
  page,
}) => {
  // The bot's browser has an authenticator, but it holds no passkey for this account.
  await addAuthenticator(page);
  await signIn(page, DEMO.email);
  await expectSignedIn(page, DEMO.name);
  const { ticket } = await gatedSubmit(page);
  await page.goto(`/approve/${ticket}`);
  await page.getByRole("button", { name: "Approve with passkey" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "The passkey check didn't complete",
  );
  expect(await state(page, ticket)).toBe("pending");
});

test("an assertion without user verification is rejected (W1)", async ({ page }) => {
  const { cdp, authenticatorId } = await addAuthenticator(page);
  await enrolPasskey(page);
  const { ticket } = await gatedSubmit(page);
  await cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified: false });
  await page.goto(`/approve/${ticket}`);
  await page.getByRole("button", { name: "Approve with passkey" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "The passkey check didn't complete",
  );
  expect(await state(page, ticket)).toBe("pending");
});

test("a challenge issued for one ticket can't approve another (W2)", async ({ page }) => {
  await signIn(page, DEMO.email);
  await expectSignedIn(page, DEMO.name);
  const a = await gatedSubmit(page);
  const b = await gatedSubmit(page);
  const headers = { origin: ORIGIN, "x-csrf-token": await csrfOf(page) };
  const options = await page.request
    .post(`/api/hitl/${a.ticket}/webauthn/options`, { headers })
    .then((r) => r.json());
  const res = await page.request.post(`/api/hitl/${b.ticket}/approve`, {
    headers,
    data: { challengeId: options.challengeId, response: { id: "x", type: "public-key" } },
  });
  expect(res.status()).toBe(400);
  expect(await res.json()).toMatchObject({ reason: "challenge_mismatch" });
  expect(await state(page, b.ticket)).toBe("pending");
});

test("only the ticket's own user can approve it (W3)", async ({ browser }) => {
  const bot = await browser.newPage();
  await signIn(bot, DEMO.email);
  await expectSignedIn(bot, DEMO.name);
  const { ticket } = await gatedSubmit(bot);

  const other = await browser.newPage();
  await clearLoginLock(SECOND.email);
  await signIn(other, SECOND.email);
  await expectSignedIn(other, SECOND.name);
  await other.goto(`/approve/${ticket}`);
  await expect(other.getByRole("heading", { level: 1 })).toHaveText(
    "This request belongs to another account",
  );
  await expect(other.getByRole("button", { name: "Approve with passkey" })).toHaveCount(0);
  await expect(other.getByRole("main")).not.toContainText("Riverside Picnic");
  expect(await state(bot, ticket)).toBe("pending");
  await bot.close();
  await other.close();
});

test("the account holder declines; a retry is rejected", async ({ page }) => {
  await signIn(page, DEMO.email);
  await expectSignedIn(page, DEMO.name);
  const { id, ticket } = await gatedSubmit(page);
  await page.goto(`/approve/${ticket}`);
  await page.getByRole("button", { name: "Decline" }).click();
  await expect(page.getByRole("main").getByRole("status")).toContainText(
    "You declined this request",
  );
  const res = await retry(page, id, ticket);
  expect(await res.json()).toMatchObject({ reason: "rejected" });
});

test("a request that expires during approval can't be approved (T7)", async ({ page }) => {
  await signIn(page, DEMO.email);
  await expectSignedIn(page, DEMO.name);
  const { ticket } = await gatedSubmit(page);
  const sql = testDb();
  try {
    await sql`update hitl_tickets set expires_at = now() - interval '1 second' where id = ${ticket}`;
  } finally {
    await sql.end();
  }
  await page.goto(`/approve/${ticket}`);
  await expect(page.getByRole("main").getByRole("status")).toContainText("This request expired");
  await expect(page.getByRole("button", { name: "Approve with passkey" })).toHaveCount(0);
  const options = await page.request.post(`/api/hitl/${ticket}/webauthn/options`, {
    headers: { origin: ORIGIN, "x-csrf-token": await csrfOf(page) },
  });
  expect(options.status()).toBe(409);
  expect(await state(page, ticket)).toBe("expired");
});

test("approving from another device uses an approval-only session (W11, T9)", async ({
  browser,
}) => {
  // The agent's browser: password session, no authenticator.
  const botContext = await browser.newContext();
  const bot = await botContext.newPage();
  await signIn(bot, DEMO.email);
  await expectSignedIn(bot, DEMO.name);
  const { id, ticket } = await gatedSubmit(bot);

  // The phone: has its own passkey, then signs out so it starts from nothing.
  const phoneContext = await browser.newContext();
  const phone = await phoneContext.newPage();
  await addAuthenticator(phone);
  await enrolPasskey(phone);
  await phone.getByRole("button", { name: "Sign out" }).click();
  await expect(phone).toHaveURL(/\/login/);

  await phone.goto(`/approve/${ticket}`);
  await expect(phone.getByRole("heading", { level: 1 })).toHaveText(
    "Sign in to review this request",
  );
  await expect(phone.getByRole("main")).not.toContainText("Riverside Picnic");
  await phone.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(phone.getByRole("heading", { level: 1 })).toHaveText("Approve this request?");
  await phone.getByRole("button", { name: "Approve with passkey" }).click();
  await expect(phone.getByRole("main").getByRole("status")).toContainText("Approved");

  // The agent's session survived the phone's passkey sign-in, and its retry works.
  const res = await retry(bot, id, ticket);
  expect(res.status()).toBe(200);

  // The approval-only session can't act on the journey, even sent as the main cookie.
  const approvalCookie = (await phoneContext.cookies()).find((c) => c.name === "dg_approval");
  expect(approvalCookie).toBeDefined();
  const sneaky = await phone.request.post("/api/applications", {
    headers: {
      origin: ORIGIN,
      cookie: `dg_session=${approvalCookie!.value}`,
      "content-type": "application/json",
    },
    data: { title: "From the approval session" },
  });
  expect(sneaky.status()).toBe(403);

  const sql = testDb();
  try {
    const [s] = await sql`select approval_only from sessions
      where signin_method = 'passkey' order by created_at desc limit 1`;
    expect(s.approval_only).toBe(true);
  } finally {
    await sql.end();
  }
  await botContext.close();
  await phoneContext.close();
});
