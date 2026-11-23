// J01-J04 journey without the gate (Phase 1), navigability (FR28) and isolation (C5).
import { expect, test, type Page } from "@playwright/test";
import { DEMO, ORIGIN, expectSignedIn, signIn } from "./helpers";

test.describe.configure({ mode: "serial" });
const SECOND_APP = "00000000-0000-4000-8000-000000000201";

// Every journey page: one h1, labelled controls, the step indicator, a next-step
// link and no dialog-only flows (design.md 4.4).
async function expectNavigable(page: Page) {
  await expect(page.locator("h1")).toHaveCount(1);
  await expect(page.getByRole("navigation", { name: "Application steps" })).toBeVisible();
  await expect(page.getByRole("link", { name: /^Next step: / })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const unlabelled = await page.evaluate(() =>
    Array.from(document.querySelectorAll("main input, main select, main textarea"))
      .filter((el) => (el as HTMLInputElement).type !== "hidden")
      .filter((el) => !(el as HTMLInputElement).labels?.length && !el.getAttribute("aria-label"))
      .map((el) => el.outerHTML),
  );
  expect(unlabelled).toEqual([]);
}

test("complete the permit journey: draft, details, document, review, declare, pay", async ({
  page,
}) => {
  await signIn(page, DEMO.email);
  await expectSignedIn(page, DEMO.name);
  await expectNavigable(page);
  await expect(page.getByRole("link", { name: "Summer Street Fair" })).toBeVisible();

  await page.getByRole("button", { name: "Start a new application" }).click();
  await expect(page).toHaveURL(/\/apply\/[0-9a-f-]+\/details$/);
  await expectNavigable(page);
  await page.getByLabel("Event name").fill("Riverside Picnic");
  await page.getByLabel("Event date").fill("2026-12-12");
  await page.getByLabel("Expected attendance (people)").fill("80");
  await page.getByLabel("Location").fill("Riverside Park, north lawn");
  await page.getByRole("button", { name: "Save and continue" }).click();

  await expect(page).toHaveURL(/\/documents$/);
  await expectNavigable(page);
  await page.getByLabel("Choose a file").setInputFiles({
    name: "site-plan.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4 fake site plan"),
  });
  await page.getByRole("button", { name: "Upload document" }).click();
  await expect(page.getByRole("main").getByRole("status")).toHaveText("Document added");
  await expect(page.getByText("site-plan.pdf")).toBeVisible();
  await page.getByRole("link", { name: "Continue to review" }).click();

  await expect(page).toHaveURL(/\/review$/);
  await expectNavigable(page);
  await expect(page.getByText("Riverside Park, north lawn")).toBeVisible();
  await expect(page.getByText("80 people")).toBeVisible();
  await page.getByRole("link", { name: "Continue to declaration" }).click();

  await expect(page).toHaveURL(/\/declare$/);
  await expectNavigable(page);
  await page
    .getByLabel("I declare that the information I have given is true and complete.")
    .check();
  await page.getByRole("button", { name: "Submit application" }).click();

  await expect(page).toHaveURL(/\/pay$/);
  await expectNavigable(page);
  await page.getByRole("button", { name: "Pay $50 (mock payment)" }).click();

  await expect(page).toHaveURL(/\/applications\/[0-9a-f-]+\?paid=1$/);
  await expectNavigable(page);
  await expect(page.getByRole("main").getByRole("status")).toContainText("Payment received");
  await expect(page.getByText("Paid", { exact: true })).toBeVisible();
});

test("submitting an incomplete draft is refused with a clear message", async ({ page }) => {
  await signIn(page, DEMO.email);
  await page.getByRole("button", { name: "Start a new application" }).click();
  const id = page.url().split("/apply/")[1].split("/")[0];
  await page.goto(`/apply/${id}/declare`);
  await page
    .getByLabel("I declare that the information I have given is true and complete.")
    .check();
  await page.getByRole("button", { name: "Submit application" }).click();
  await expect(page).toHaveURL(/\/declare\?error=incomplete$/);
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Some event details are missing",
  );
});

test("delete an application after confirming on its own page", async ({ page }) => {
  await signIn(page, DEMO.email);
  await page.getByRole("link", { name: "Winter Lights Walk" }).click();
  await page.getByRole("link", { name: "Delete application" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Delete this application?");
  await expectNavigable(page);
  await page.getByRole("button", { name: "Delete application" }).click();
  await expect(page).toHaveURL(/\/applications\?deleted=1$/);
  await expect(page.getByRole("link", { name: "Winter Lights Walk" })).toHaveCount(0);
});

test("change the recovery contact details", async ({ page }) => {
  await signIn(page, DEMO.email);
  await page.getByRole("link", { name: "Contact details" }).click();
  await expect(page.locator("h1")).toHaveCount(1);
  await page.getByLabel("Recovery email").fill("new@example.test");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("main").getByRole("status")).toHaveText("Contact details saved");
  await expect(page.getByLabel("Recovery email")).toHaveValue("new@example.test");
});

test("another user's application is not found, by page and by API", async ({ page }) => {
  await signIn(page, DEMO.email);
  const res = await page.goto(`/applications/${SECOND_APP}`);
  expect(res?.status()).toBe(404);
  const api = await page.request.get(`/api/applications/${SECOND_APP}`);
  expect(api.status()).toBe(404);
  const csrf = await page.locator('meta[name="csrf-token"]').getAttribute("content");
  const pay = await page.request.post(`/api/applications/${SECOND_APP}/pay`, {
    headers: { origin: ORIGIN, "x-csrf-token": csrf!, "content-type": "application/json" },
    data: {},
  });
  expect(pay.status()).toBe(404);
});

test("journey API calls need the CSRF token", async ({ page }) => {
  await signIn(page, DEMO.email);
  const res = await page.request.post("/api/applications", {
    headers: { origin: ORIGIN, "content-type": "application/json" },
    data: { title: "Sneaky" },
  });
  expect(res.status()).toBe(403);
});
