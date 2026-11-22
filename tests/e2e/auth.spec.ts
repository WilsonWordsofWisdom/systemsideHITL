// J01 sign-in scenarios (FR6, FR8, FR9) and CSRF / origin checks (J07, control S2).
import { expect, test } from "@playwright/test";
import { DEMO, ORIGIN, SECOND, expectSignedIn, signIn, testDb } from "./helpers";

test.describe.configure({ mode: "serial" });

test("sign in with the demo password, then sign out", async ({ page, context }) => {
  await signIn(page, DEMO.email);
  await expectSignedIn(page, DEMO.name);

  const cookie = (await context.cookies()).find((c) => c.name === "dg_session");
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe("Lax");

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login\?signed_out=1$/);
  await expect(page.getByText("You have signed out.")).toBeVisible();

  await page.goto("/applications");
  await expect(page).toHaveURL(/\/login$/);
});

test("the login records signals and the self-declared class", async ({ page }) => {
  await signIn(page, DEMO.email, undefined, true);
  await expectSignedIn(page, DEMO.name);
  const sql = testDb();
  try {
    const [row] = await sql`select signin_method, declared_agent, login_actor_class, login_signals
      from sessions where revoked_at is null order by created_at desc limit 1`;
    expect(row.signin_method).toBe("password");
    expect(row.declared_agent).toBe(true);
    expect(row.login_actor_class).toBe("declared_agent");
    expect(row.login_signals.selfDeclared).toBe(true);
    // Playwright drives the browser, so signals.js reports navigator.webdriver, and
    // fill() sets field values without key presses: the pattern many agents show.
    expect(row.login_signals.client.webdriver).toBe(true);
    expect(row.login_signals.client.clicks).toBeGreaterThanOrEqual(1);
    expect(row.login_signals.client.keys).toBe(0);
  } finally {
    await sql.end();
  }
});

test("a wrong password and an unknown account get the same message", async ({ page }) => {
  await signIn(page, DEMO.email, "wrong-password-1");
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Email or password is incorrect",
  );
  await signIn(page, "nobody@demogov.test", "wrong-password-1");
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Email or password is incorrect",
  );
});

test("five wrong passwords in a minute lock the account", async ({ page }) => {
  for (let i = 0; i < 5; i++) await signIn(page, SECOND.email, `wrong-password-${i}`);
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Too many attempts");
  // Even the right password is refused while locked.
  await signIn(page, SECOND.email);
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Too many attempts");
  await expect(page).toHaveURL(/error=locked/);
});

test("signing out without a CSRF token is rejected", async ({ page }) => {
  await signIn(page, DEMO.email);
  await expectSignedIn(page, DEMO.name);
  const res = await page.request.post("/api/auth/logout", {
    headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
    data: "",
  });
  expect(res.status()).toBe(403);
  await page.goto("/applications");
  await expectSignedIn(page, DEMO.name);
});

test("a sign-in posted from another origin is rejected", async ({ request }) => {
  const res = await request.post("/api/auth/login", {
    headers: { origin: "https://evil.example", "content-type": "application/json" },
    data: { email: DEMO.email, password: "e2e-demo-password-123" },
  });
  expect(res.status()).toBe(400);
  expect(res.headers()["set-cookie"]).toBeUndefined();
});

test("signals are accepted from a signed-in page only with the CSRF token", async ({ page }) => {
  await signIn(page, DEMO.email);
  await expectSignedIn(page, DEMO.name);
  const csrf = await page.locator('meta[name="csrf-token"]').getAttribute("content");
  const ok = await page.request.post("/api/signals", {
    headers: { origin: ORIGIN, "x-csrf-token": csrf!, "content-type": "application/json" },
    data: { v: 1, clicks: 2 },
  });
  expect(ok.status()).toBe(204);
  const bad = await page.request.post("/api/signals", {
    headers: { origin: ORIGIN, "content-type": "application/json" },
    data: { v: 1 },
  });
  expect(bad.status()).toBe(403);
});
