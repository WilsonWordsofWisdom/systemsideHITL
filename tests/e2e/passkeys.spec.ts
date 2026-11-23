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
  await expect(page.getByText("Passkey 1")).toBeVisible();

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
