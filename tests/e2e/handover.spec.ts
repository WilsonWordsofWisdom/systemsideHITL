// Session risk and handover (J06; FR35-FR38, controls A8, A9; T10c).
import { expect, request, test, type Page } from "@playwright/test";
import { DEMO, ORIGIN, expectSignedIn, signIn, testDb } from "./helpers";

test.describe.configure({ mode: "serial" });
const DRAFT = "00000000-0000-4000-8000-000000000103"; // Winter Lights Walk

async function sessionRow(page: Page) {
  const token = (await page.context().cookies()).find((c) => c.name === "dg_session")!.value;
  const sql = testDb();
  try {
    const { createHash } = await import("node:crypto");
    const id = createHash("sha256").update(token).digest("hex");
    const [s] = await sql`select id, risk_state from sessions where id = ${id}`;
    const events = await sql`select event, from_state, to_state, trigger from session_events
      where session_id = ${id} order by ts`;
    return { token, session: s, events };
  } finally {
    await sql.end();
  }
}

test("agent evidence at sign-in starts the session at agent_observed", async ({ page }) => {
  await signIn(page, DEMO.email);
  await expectSignedIn(page, DEMO.name);
  const { session, events } = await sessionRow(page);
  expect(session.risk_state).toBe("agent_observed");
  expect(events).toEqual([
    {
      event: "risk_changed",
      from_state: "clean",
      to_state: "agent_observed",
      trigger: "login_agent_evidence",
    },
  ]);
});

test("T10c: a session cookie copied into a script is flagged and the gate holds", async ({
  page,
}) => {
  await signIn(page, DEMO.email);
  await expectSignedIn(page, DEMO.name);
  const csrf = (await page.locator('meta[name="csrf-token"]').getAttribute("content"))!;
  const { token } = await sessionRow(page);

  // The same cookie, used from a script with its own client.
  const script = await request.newContext({
    baseURL: ORIGIN,
    userAgent: "python-requests/2.32",
    extraHTTPHeaders: { cookie: `dg_session=${token}` },
  });
  const res = await script.post(`/api/applications/${DRAFT}/submit`, {
    headers: { origin: ORIGIN, "x-csrf-token": csrf },
    data: { declaration: "on" },
  });
  expect(res.status()).toBe(403);
  expect(await res.json()).toMatchObject({ status: "requires_human_approval" });
  await script.dispose();

  const { session, events } = await sessionRow(page);
  expect(session.risk_state).toBe("handover_suspected");
  expect(events.at(-1)).toMatchObject({
    from_state: "agent_observed",
    to_state: "handover_suspected",
    trigger: "client_context_changed",
  });
});
