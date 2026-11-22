// J01 landing page scenarios (FR5) and baseline headers (S4, W10).
import { expect, test } from "@playwright/test";
import { findModelDirectedText } from "../../lib/content";

test("landing page explains the service without addressing models", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  const response = await page.goto("/");

  await expect(page).toHaveTitle("DemoGov Permits");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(
    page.getByText("Prototype for testing, not a real government service."),
  ).toBeVisible();
  await expect(page.locator("h1")).toHaveCount(1);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Apply for a Community Event Permit",
  );
  await expect(page.getByRole("listitem")).toHaveCount(7);
  await expect(page.getByRole("link", { name: "Sign in to start" })).toHaveAttribute(
    "href",
    "/login",
  );

  const text = await page.locator("body").innerText();
  expect(findModelDirectedText(text)).toEqual([]);
  // With AGENT_HINTS off the page does not mention human approval.
  expect(text.toLowerCase()).not.toContain("approv");

  const headers = response!.headers();
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(errors).toEqual([]);
});
