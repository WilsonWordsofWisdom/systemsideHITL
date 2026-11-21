import { expect, test } from "@playwright/test";

// Phase 0 smoke test: the app serves, with the prototype banner (control D5) and one h1.
test("home page shows the prototype banner and a single heading", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

  await page.goto("/");
  await expect(page).toHaveTitle("DemoGov Permits");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(
    page.getByText("Prototype for testing, not a real government service."),
  ).toBeVisible();
  await expect(page.locator("h1")).toHaveCount(1);
  await expect(page.locator("main#main")).toBeVisible();
  expect(errors).toEqual([]);
});
