// J13 T16 (FR42, controls PP1, PP2): Poppy discovery is absent in baseline runs and
// served with POPPY=on, without changing what MCP clients see.
import { expect, test } from "@playwright/test";
import { startVariant, type Variant } from "./variant";

test("Poppy routes are absent in baseline runs; OAuth metadata unchanged", async ({ request }) => {
  expect((await request.get("/.well-known/poppy.json")).status()).toBe(404);
  expect((await request.get("/api/poppy/tasks")).status()).toBe(404);
  expect(
    (await request.post("/api/poppy/feedback", { data: { task: "x", description: "y" } })).status(),
  ).toBe(404);
  const root = await request.get("/.well-known/oauth-protected-resource");
  expect(root.status()).toBe(200);
  expect((await root.json()).resource).toMatch(/\/mcp$/);
});

test.describe("variant: POPPY=on", () => {
  let variant: Variant;
  test.beforeAll(async () => {
    variant = await startVariant(3107, { POPPY: "on" });
  });
  test.afterAll(async () => variant.stop());

  test("discovery, tasks and feedback work; /mcp still has its metadata", async ({ request }) => {
    const o = variant.origin;
    const doc = await request.get(`${o}/.well-known/poppy.json`);
    expect(doc.status()).toBe(200);
    expect(await doc.json()).toMatchObject({
      protocol_version: "1.0",
      organization: { domain: "localhost:3107" },
      web: {},
      tasks: { endpoint: `${o}/api/poppy/tasks` },
    });

    expect((await request.get(`${o}/.well-known/oauth-protected-resource`)).status()).toBe(404);
    const mcp = await request.get(`${o}/.well-known/oauth-protected-resource/mcp`);
    expect(mcp.status()).toBe(200);
    expect((await mcp.json()).resource).toBe(`${o}/mcp`);
    // The /mcp challenge still points clients at the /mcp metadata.
    const challenge = (await request.post(`${o}/mcp`, { data: {} })).headers()["www-authenticate"];
    expect(challenge).toContain(`${o}/.well-known/oauth-protected-resource/mcp`);

    const tasks = await request.get(`${o}/api/poppy/tasks`, {
      headers: { "poppy-version": "1.0" },
    });
    expect(tasks.status()).toBe(200);
    expect((await tasks.json()).excluded_tasks.map((t: { task: string }) => t.task)).toEqual([
      "Change the recovery email or phone",
    ]);

    const feedback = await request.post(`${o}/api/poppy/feedback`, {
      headers: { "poppy-version": "1.0", "x-forwarded-for": "192.0.2.77" },
      data: { task: "Change the recovery email", description: "Refused for assistants." },
    });
    expect(feedback.status()).toBe(202);
  });
});
