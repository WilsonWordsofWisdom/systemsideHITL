// J12 passkey enrolment and J01 passkey sign-in, using Chrome's virtual
// WebAuthn authenticator (test mode only, control W8).
import { expect, test } from "@playwright/test";
import {
  DEMO,
  addAuthenticator,
  removeAuthenticators,
  enrolPasskey,
  expectSignedIn,
  signIn,
  testDb,
} from "./helpers";

test.describe.configure({ mode: "serial" });
test.afterEach(removeAuthenticators);

test("enrol a passkey, then sign in with it; other sessions end", async ({ page, browser }) => {
  // A second browser signed in with the password: its session must end when the
  // passkey sign-in resets the user's sessions (control S9).
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await signIn(otherPage, DEMO.email);
  await expectSignedIn(otherPage, DEMO.name);

  await addAuthenticator(page);
  await enrolPasskey(page);
  await expect(page.getByText("Passkey 1", { exact: true })).toBeVisible();

  const sql = testDb();
  try {
    const [audit] = await sql`select outcome, reason, actor_signals from request_log
      where path_or_tool = 'passkey_enrol' order by ts desc limit 1`;
    expect(audit.outcome).toBe("executed");
    expect(audit.reason).toBe("passkey_enrolled");
    expect(audit.actor_signals).toHaveProperty("attestationFormat");

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.getByRole("button", { name: "Sign in with a passkey" }).click();
    await expectSignedIn(page, DEMO.name);

    const [session] = await sql`select signin_method, login_actor_class from sessions
      where revoked_at is null order by created_at desc limit 1`;
    expect(session.signin_method).toBe("passkey");
    // Playwright sets navigator.webdriver, so the classifier scores the passkey
    // sign-in as a suspected agent rather than human (architecture 4.7).
    expect(session.login_actor_class).toBe("suspected_agent");
    const [reset] =
      await sql`select count(*)::int as n from sessions where revoke_reason = 'passkey_reset'`;
    expect(reset.n).toBeGreaterThanOrEqual(1);
  } finally {
    await sql.end();
  }

  await otherPage.goto("/applications");
  await expect(otherPage).toHaveURL(/\/login$/);
  await other.close();
});

test("a passkey sign-in without user verification is refused", async ({ page }) => {
  const { cdp, authenticatorId } = await addAuthenticator(page);
  await enrolPasskey(page);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);

  // The authenticator now answers without verifying the user (no biometric or PIN).
  await cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified: false });
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Passkey sign-in didn't work",
  );
  await expect(page).toHaveURL(/\/login/);
});

test("a password sign-in can't add a passkey without a valid enrolment code (H1, W12)", async ({
  page,
}) => {
  await addAuthenticator(page);
  await signIn(page, DEMO.email);
  await expectSignedIn(page, DEMO.name);
  const sql = testDb();
  try {
    const [before] = await sql`select count(*)::int as n from passkeys`;
    await page.goto("/account/passkeys");
    const alert = page.getByRole("main").getByRole("alert");
    await page.getByRole("button", { name: "Add a passkey" }).click();
    await expect(alert).toContainText("enrolment code");
    await page.getByLabel("Enrolment code").fill("AAAA-AAAA-AAAA");
    await page.getByRole("button", { name: "Add a passkey" }).click();
    await expect(alert).toContainText("isn't valid");
    const [after] = await sql`select count(*)::int as n from passkeys`;
    expect(after.n).toBe(before.n);
    const refusals = await sql`select reason from request_log
      where path_or_tool = 'passkey_enrol_options' and outcome = 'blocked'
      order by ts desc limit 2`;
    expect(refusals.map((r) => r.reason)).toContain("code_invalid");
  } finally {
    // Wrong codes count towards the per-account lock; other specs enrol as this user.
    await sql`delete from rate_limits where key like 'enrol_code:%'`;
    await sql.end();
  }
});

test("after a passkey sign-in, another passkey can be added without a code (H1, W12)", async ({
  page,
}) => {
  const first = await addAuthenticator(page);
  await enrolPasskey(page);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expectSignedIn(page, DEMO.name);

  // A second device: the first authenticator already holds a passkey for this account.
  await first.cdp.send("WebAuthn.removeVirtualAuthenticator", {
    authenticatorId: first.authenticatorId,
  });
  await addAuthenticator(page);
  await page.goto("/account/passkeys");
  await expect(page.getByLabel("Enrolment code")).toHaveCount(0);
  await page.getByRole("button", { name: "Add a passkey" }).click();
  await expect(page.getByRole("main").getByRole("status")).toHaveText("Passkey added.");

  const sql = testDb();
  try {
    const [audit] = await sql`select actor_signals from request_log
      where path_or_tool = 'passkey_enrol' and outcome = 'executed' order by ts desc limit 1`;
    expect(audit.actor_signals).toMatchObject({ via: "passkey" });
  } finally {
    await sql.end();
  }
});
