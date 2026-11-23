// J01 landing page scenarios (FR5) and baseline headers (S4, W10).
import { expect, test } from "@playwright/test";
import { findModelDirectedText } from "../../lib/content";
import { startVariant } from "./variant";

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

test("agent hint files are absent in baseline runs (FR41)", async ({ request }) => {
  expect((await request.get("/llms.txt")).status()).toBe(404);
  expect((await request.get("/agents.md")).status()).toBe(404);
});

test("with AGENT_HINTS=on the landing page names the approval steps and links the hint files (FR5, FR41)", async ({
  page,
}) => {
  const variant = await startVariant(3105, { AGENT_HINTS: "on" });
  try {
    await page.goto(`${variant.origin}/`);
    const hints = page.getByRole("region", { name: "Some steps need the account holder" });
    await expect(hints).toContainText("approved by the account holder with a passkey");
    await expect(hints.getByRole("link", { name: "/llms.txt" })).toHaveAttribute(
      "href",
      "/llms.txt",
    );
    await expect(hints.getByRole("link", { name: "/agents.md" })).toHaveAttribute(
      "href",
      "/agents.md",
    );
    expect(findModelDirectedText(await page.locator("body").innerText())).toEqual([]);

    for (const [file, type] of [
      ["/llms.txt", "text/plain"],
      ["/agents.md", "text/markdown"],
    ]) {
      const res = await page.request.get(`${variant.origin}${file}`);
      expect(res.status(), file).toBe(200);
      expect(res.headers()["content-type"]).toContain(type);
      const text = await res.text();
      expect(text).toContain("DemoGov Permits");
      expect(findModelDirectedText(text), file).toEqual([]);
    }
  } finally {
    await variant.stop();
  }
});
