import { expect, type Page } from "@playwright/test";
import postgres from "postgres";
import { E2E_DEMO_PASSWORD, E2E_ORIGIN, e2eDatabase } from "./env";

export const DEMO = { email: "demo@demogov.test", name: "Demo User" };
export const SECOND = { email: "second@demogov.test", name: "Second User" };
export const PASSWORD = E2E_DEMO_PASSWORD;
export const ORIGIN = E2E_ORIGIN;

// Access to the test database, for assertions.
export const testDb = () => postgres(e2eDatabase().direct, { prepare: false, max: 1 });

export async function signIn(page: Page, email: string, password = PASSWORD, selfDeclare = false) {
  await page.goto("/login");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password").fill(password);
  if (selfDeclare) await page.getByLabel("I'm an AI agent acting for someone").check();
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

// Checks the handoff panel (design.md 4.5) and returns the ticket from its JSON block.
export async function handoffTicket(page: Page, action: string, origin = ORIGIN): Promise<string> {
  const panel = page.getByRole("main").getByRole("alert");
  await expect(panel).toContainText("Human approval needed");
  await expect(panel.getByRole("link", { name: /\/approve\/hitl_/ })).toBeVisible();
  const json = JSON.parse((await page.locator("#hitl-handoff").textContent()) ?? "{}");
  expect(json).toMatchObject({ status: "requires_human_approval", action });
  expect(new URL(json.continue_url).origin).toBe(origin);
  return json.ticket_id as string;
}

// auth.spec's lockout test locks the second user for 10 minutes on purpose; specs
// that sign in as that user afterwards clear the lock first.
export async function clearLoginLock(email: string) {
  const sql = testDb();
  try {
    await sql`delete from rate_limits where key = ${`login:email:${email}`}`;
  } finally {
    await sql.end();
  }
}

// The account holder approves on /approve with the passkey in this browser.
export async function approveWithPasskey(page: Page, ticketId: string) {
  await page.goto(`/approve/${ticketId}`);
  await page.getByRole("button", { name: "Approve with passkey" }).click();
  await expect(page.getByRole("main").getByRole("status")).toContainText("Approved");
}

export async function expectSignedIn(page: Page, name: string) {
  // Allows for network latency when E2E_TARGET=supabase.
  await expect(page).toHaveURL(/\/applications$/, { timeout: 15_000 });
  await expect(page.getByText(`Signed in as ${name}`).first()).toBeVisible();
}

// Chrome's virtual WebAuthn authenticator (test mode only, control W8).
export async function addAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { cdp, authenticatorId };
}

export async function enrolPasskey(page: Page) {
  await signIn(page, DEMO.email);
  await expectSignedIn(page, DEMO.name);
  await page.goto("/account/passkeys");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Passkeys");
  await page.getByRole("button", { name: "Add a passkey" }).click();
  await expect(page.getByRole("main").getByRole("status")).toHaveText("Passkey added.");
}
