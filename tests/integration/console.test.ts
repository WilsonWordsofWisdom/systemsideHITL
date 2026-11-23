// Console queries against the database: filters, runs and ground truth (FR16, FR39, FR40).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSession } from "@/lib/auth/session";
import { runs } from "@/lib/db/schema";
import type { AppDb } from "@/lib/db/types";
import { listRequests, listRuns, setRunLabel } from "@/lib/console/queries";
import { classifyActor, getClassifierConfig } from "@/lib/hitl/classifier";
import { logEvent } from "@/lib/log";
import { DEMO_USER_ID } from "@/scripts/seed";
import { createTestDb } from "../helpers/db";

let db: AppDb;
let close: () => Promise<void>;
let sessionA: string;
let sessionB: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb({ seed: true }));
  sessionA = (
    await createSession(db, { userId: DEMO_USER_ID, signinMethod: "password", runId: "r42" })
  ).session.id;
  sessionB = (await createSession(db, { userId: DEMO_USER_ID, signinMethod: "password" })).session
    .id;
  const row = (sessionId: string, runId: string | null, outcome: "gated" | "executed") =>
    logEvent(db, { route: "api", method: "POST", pathOrTool: "/x", sessionId, runId, outcome });
  await row(sessionA, "r42", "gated");
  await row(sessionA, "r42", "executed");
  await row(sessionB, "r43", "executed");
  await row(sessionB, null, "executed");
});
afterAll(async () => close());

describe("request filters", () => {
  it("filters by run", async () => {
    const rows = await listRequests(db, { run: "r42" });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.runId === "r42")).toBe(true);
  });

  it("filters by session ID prefix", async () => {
    const rows = await listRequests(db, { session: sessionB.slice(0, 10) });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.sessionId === sessionB)).toBe(true);
  });

  it("filters by agent label through the runs' ground truth", async () => {
    await setRunLabel(db, "r43", { agentLabel: "ChatGPT agent, web", actualActor: "agent" });
    const rows = await listRequests(db, { agent: "ChatGPT agent, web" });
    expect(rows.map((r) => r.runId)).toEqual(["r43"]);
    expect(await listRequests(db, { agent: "Nobody" })).toEqual([]);
  });

  it("ignores malformed filter values rather than matching everything oddly", async () => {
    const all = await listRequests(db, {});
    expect(await listRequests(db, { run: "bad run!", session: "zz" })).toHaveLength(all.length);
  });

  it("returns newest first", async () => {
    const rows = await listRequests(db, {});
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1].ts.getTime()).toBeGreaterThanOrEqual(rows[i].ts.getTime());
    }
  });
});

describe("runs and ground truth", () => {
  it("lists every run seen in requests or sessions, with its label", async () => {
    const list = await listRuns(db);
    expect(list.map((r) => r.id)).toEqual(expect.arrayContaining(["r42", "r43"]));
    expect(list.find((r) => r.id === "r43")?.agentLabel).toBe("ChatGPT agent, web");
  });

  it("updates a label in place and rejects bad run IDs and actor values", async () => {
    await setRunLabel(db, "r42", {
      agentLabel: "Claude, web",
      actualActor: "robot",
      notes: "  hi  ",
    });
    const [r] = (await db.select().from(runs)).filter((x) => x.id === "r42");
    expect(r).toMatchObject({ agentLabel: "Claude, web", actualActor: null, notes: "hi" });
    await expect(setRunLabel(db, "bad run", {})).rejects.toThrow();
  });

  it("the label never changes the classifier's output (A6, FR16)", async () => {
    const cfg = getClassifierConfig();
    const input = {
      route: "web" as const,
      protocolAgent: null,
      selfDeclared: false,
      xAgent: null,
      userAgent: "Mozilla/5.0 Chrome/140",
      headers: { acceptLanguage: true, secFetchSite: "same-origin" },
      behaviour: [],
      noPriorPageView: false,
      clientContextChanged: false,
      session: {
        signinMethod: "password" as const,
        loginActorClass: "unknown" as const,
        riskState: "clean" as const,
      },
    };
    const before = classifyActor(input, cfg);
    await setRunLabel(db, "r42", { agentLabel: "Definitely an agent", actualActor: "agent" });
    expect(classifyActor(input, cfg)).toEqual(before);
    // The classifier takes no run or label input at all.
    expect(Object.keys(input)).not.toContain("runId");
  });
});
