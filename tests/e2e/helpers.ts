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

export async function expectSignedIn(page: Page, name: string) {
  await expect(page).toHaveURL(/\/applications$/);
  await expect(page.getByText(`Signed in as ${name}`).first()).toBeVisible();
}
