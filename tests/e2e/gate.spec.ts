// The gate over HTTP (J02 "gate fires", J07 bypass, FR19, FR21, FR24).
import { expect, test, type Page } from "@playwright/test";
import { DEMO, ORIGIN, SECOND, clearLoginLock, expectSignedIn, signIn } from "./helpers";

test.describe.configure({ mode: "serial" });
const DRAFT = "00000000-0000-4000-8000-000000000103"; // Winter Lights Walk, complete draft

async function signedIn(page: Page, user: { email: string; name: string }) {
  await signIn(page, user.email);
  await expectSignedIn(page, user.name);
  return (await page.locator('meta[name="csrf-token"]').getAttribute("content"))!;
}

test("a direct submit API call gets the requires_human_approval contract (T11)", async ({
  page,
}) => {
  const csrf = await signedIn(page, DEMO);
  const res = await page.request.post(`/api/applications/${DRAFT}/submit`, {
    headers: { origin: ORIGIN, "x-csrf-token": csrf },
    // A client-supplied continue URL must be ignored (T7).
    data: { declaration: "on", continue_url: "https://evil.example/approve" },
  });
  expect(res.status()).toBe(403);
  expect(res.headers()["www-authenticate"]).toContain("insufficient_user_authentication");
  const body = await res.json();
  expect(body).toMatchObject({
    status: "requires_human_approval",
    action: "submit_application",
    message_for_user: "A person must approve this step. Open the link to continue.",
    resume: { retry_with_header: "X-HITL-Ticket" },
  });
  expect(body.continue_url).toBe(`${ORIGIN}/approve/${body.ticket_id}`);

  // An identical repeat returns the same pending ticket.
  const again = await page.request.post(`/api/applications/${DRAFT}/submit`, {
    headers: { origin: ORIGIN, "x-csrf-token": csrf },
    data: { declaration: "on" },
  });
  expect((await again.json()).ticket_id).toBe(body.ticket_id);

  // The poll endpoint shows it pending, with the preview from the ticket.
  const poll = await page.request.get(body.resume.poll);
  expect(await poll.json()).toMatchObject({
    state: "pending",
    action: "submit_application",
    preview: { title: "Winter Lights Walk" },
  });

  // Still a draft.
  const app = await page.request.get(`/api/applications/${DRAFT}`).then((r) => r.json());
  expect(app.application.status).toBe("draft");
});

test("a made-up or unapproved ticket is rejected with a reason", async ({ page }) => {
  const csrf = await signedIn(page, DEMO);
  const send = (ticket: string) =>
    page.request.post(`/api/applications/${DRAFT}/submit`, {
      headers: { origin: ORIGIN, "x-csrf-token": csrf, "x-hitl-ticket": ticket },
      data: { declaration: "on" },
    });
  const madeUp = await send(`hitl_${"A".repeat(43)}`);
  expect(madeUp.status()).toBe(409);
  expect(await madeUp.json()).toMatchObject({ status: "ticket_invalid", reason: "not_found" });

  const gated = await page.request
    .post(`/api/applications/${DRAFT}/submit`, {
      headers: { origin: ORIGIN, "x-csrf-token": csrf },
      data: { declaration: "on" },
    })
    .then((r) => r.json());
  const pending = await send(gated.ticket_id);
  expect(await pending.json()).toMatchObject({ reason: "not_approved" });
});

test("another user can't read the ticket status", async ({ browser }) => {
  const demo = await browser.newPage();
  const csrf = await signedIn(demo, DEMO);
  const gated = await demo.request
    .post(`/api/applications/${DRAFT}/submit`, {
      headers: { origin: ORIGIN, "x-csrf-token": csrf },
      data: { declaration: "on" },
    })
    .then((r) => r.json());

  const second = await browser.newPage();
  await clearLoginLock(SECOND.email);
  await signedIn(second, SECOND);
  const poll = await second.request.get(`/api/hitl/${gated.ticket_id}`);
  expect(poll.status()).toBe(404);
  // Close both, so the waiting page doesn't keep an event stream open.
  await demo.close();
  await second.close();
});

test("the update_contact API is denied to a suspected agent", async ({ page }) => {
  const csrf = await signedIn(page, DEMO);
  const res = await page.request.put("/api/account/contact", {
    headers: { origin: ORIGIN, "x-csrf-token": csrf },
    data: { phone: "+1 555 0199" },
  });
  expect(res.status()).toBe(403);
  expect(await res.json()).toMatchObject({ status: "denied", action: "update_contact" });
});
