// Poppy slice A routes (J13 T16, FR42, controls PP1, PP2) and Retry-After on 429s.
// Route handlers run against a PGlite database injected where getDb() looks for it.
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { rateLimits, requestLog } from "@/lib/db/schema";
import type { AppDb } from "@/lib/db/types";
import { clientIp, ipHash } from "@/lib/http";
import { FEEDBACK_LIMIT } from "@/lib/poppy/feedback";
import { createTestDb } from "../helpers/db";

vi.mock("server-only", () => ({}));

const ORIGIN = "https://hitltest.example";
const SECRET = "test-session-secret-0123456789abcdef";
process.env.APP_ORIGIN = ORIGIN;
process.env.RP_ID = "hitltest.example";
process.env.SESSION_SECRET = SECRET;

let db: AppDb;
let close: () => Promise<void>;
const saved = process.env.POPPY;

beforeAll(async () => {
  ({ db, close } = await createTestDb({ seed: true }));
  (globalThis as { __appDb?: AppDb }).__appDb = db;
});
afterAll(async () => {
  delete (globalThis as { __appDb?: AppDb }).__appDb;
  await close();
});
afterEach(() => {
  process.env.POPPY = saved;
});

const routes = async () => ({
  doc: (await import("@/app/.well-known/poppy.json/route")).GET,
  rootPrm: (await import("@/app/.well-known/oauth-protected-resource/route")).GET,
  mcpPrm: (await import("@/app/.well-known/oauth-protected-resource/mcp/route")).GET,
  tasks: (await import("@/app/api/poppy/tasks/route")).GET,
  feedback: (await import("@/app/api/poppy/feedback/route")).POST,
});

const get = (path: string, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${path}`, { headers });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("with POPPY off (baseline)", () => {
  it("every Poppy route is 404 and the root OAuth metadata is unchanged", async () => {
    delete process.env.POPPY;
    const r = await routes();
    expect(r.doc().status).toBe(404);
    expect(r.tasks(get("/api/poppy/tasks")).status).toBe(404);
    expect(
      (await r.feedback(post("/api/poppy/feedback", { task: "x", description: "y" }))).status,
    ).toBe(404);
    const root = r.rootPrm();
    expect(root.status).toBe(200);
    expect((await root.json()).resource).toBe(`${ORIGIN}/mcp`);
  });
});

describe("with POPPY on", () => {
  it("serves poppy.json for this host", async () => {
    process.env.POPPY = "on";
    const res = (await routes()).doc();
    expect(res.status).toBe(200);
    const doc = await res.json();
    expect(doc.organization.domain).toBe("hitltest.example");
    expect(doc.tasks.endpoint).toBe(`${ORIGIN}/api/poppy/tasks`);
  });

  it("says 'no issuer' at the root OAuth location; /mcp metadata still answers", async () => {
    process.env.POPPY = "on";
    const r = await routes();
    expect(r.rootPrm().status).toBe(404);
    const mcp = r.mcpPrm();
    expect(mcp.status).toBe(200);
    expect((await mcp.json()).resource).toBe(`${ORIGIN}/mcp`);
  });

  it("serves the tasks list and checks Poppy-Version", async () => {
    process.env.POPPY = "on";
    const { tasks } = await routes();
    const ok = tasks(get("/api/poppy/tasks", { "poppy-version": "1.0" }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).excluded_tasks[0].task).toBe("Change the recovery email or phone");
    expect(tasks(get("/api/poppy/tasks")).status).toBe(200);
    const bad = tasks(get("/api/poppy/tasks", { "poppy-version": "2.0" }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "version_unsupported" });
  });

  it("refuses malformed feedback", async () => {
    process.env.POPPY = "on";
    const { feedback } = await routes();
    for (const body of [
      "not json",
      {},
      { task: "x" },
      { task: "x".repeat(201), description: "y" },
    ]) {
      const res = await feedback(post("/api/poppy/feedback", body));
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_request" });
    }
    const version = await feedback(
      post("/api/poppy/feedback", { task: "x", description: "y" }, { "poppy-version": "3.0" }),
    );
    expect(version.status).toBe(400);
  });

  it("logs feedback, then rate limits with Retry-After", async () => {
    process.env.POPPY = "on";
    const { feedback } = await routes();
    const headers = { "x-forwarded-for": "198.51.100.7", "poppy-version": "1.0" };
    const report = { task: "Change the recovery email", description: "The site refused it." };
    const first = await feedback(post("/api/poppy/feedback", report, headers));
    expect(first.status).toBe(202);
    expect(await first.text()).toBe("");
    const [row] = await db
      .select()
      .from(requestLog)
      .where(eq(requestLog.pathOrTool, "poppy_feedback"));
    expect(row.actorSignals).toEqual({ poppy: report });
    expect(row.outcome).toBe("executed");

    for (let i = 1; i < FEEDBACK_LIMIT.max; i++) {
      await feedback(post("/api/poppy/feedback", report, headers));
    }
    const limited = await feedback(post("/api/poppy/feedback", report, headers));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});

describe("Retry-After on existing 429s", () => {
  const lock = async (key: string) => {
    const until = new Date(Date.now() + 120_000);
    await db
      .insert(rateLimits)
      .values({ key, windowStart: new Date(), count: 0, lockedUntil: until })
      .onConflictDoUpdate({ target: rateLimits.key, set: { lockedUntil: until } });
  };

  it("on a locked JSON sign-in", async () => {
    await lock("login:email:demo@demogov.test");
    const { POST } = await import("@/app/api/auth/login/route");
    const res = await POST(
      post(
        "/api/auth/login",
        { email: "demo@demogov.test", password: "whatever-password" },
        { origin: ORIGIN },
      ),
    );
    expect(res.status).toBe(429);
    const seconds = Number(res.headers.get("retry-after"));
    expect(seconds).toBeGreaterThan(100);
    expect(seconds).toBeLessThanOrEqual(120);
  });

  it("on a locked client registration", async () => {
    const request = post(
      "/api/oauth/register",
      { client_name: "x", redirect_uris: [] },
      {
        "x-forwarded-for": "203.0.113.9",
      },
    );
    await lock(`oauth:register:${ipHash(clientIp(request), SECRET)}`);
    const { POST } = await import("@/app/api/oauth/register/route");
    const res = await POST(request);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(100);
  });
});
