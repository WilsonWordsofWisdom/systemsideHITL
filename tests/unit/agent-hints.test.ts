// /llms.txt and /agents.md (FR41, FR25, control P1): served only with
// AGENT_HINTS=on, declarative, and accurate about the routes they list.
import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GET as agentsMd } from "@/app/agents.md/route";
import { GET as llmsTxt } from "@/app/llms.txt/route";
import { AGENTS_MD, LLMS_TXT } from "@/lib/agent-hints";
import { findModelDirectedText } from "@/lib/content";

const saved = process.env.AGENT_HINTS;
afterEach(() => {
  process.env.AGENT_HINTS = saved;
});

describe("agent hint files", () => {
  it("return 404 with the flag off and the text with it on", async () => {
    for (const value of [undefined, "off", "true"]) {
      if (value === undefined) delete process.env.AGENT_HINTS;
      else process.env.AGENT_HINTS = value;
      expect(llmsTxt().status, String(value)).toBe(404);
      expect(agentsMd().status, String(value)).toBe(404);
    }
    process.env.AGENT_HINTS = "on";
    const txt = llmsTxt();
    expect(txt.status).toBe(200);
    expect(txt.headers.get("content-type")).toContain("text/plain");
    expect(await txt.text()).toBe(LLMS_TXT);
    const md = agentsMd();
    expect(md.headers.get("content-type")).toContain("text/markdown");
    expect(await md.text()).toBe(AGENTS_MD);
  });

  it("contain no model-directed text (P1)", () => {
    expect(findModelDirectedText(LLMS_TXT)).toEqual([]);
    expect(findModelDirectedText(AGENTS_MD)).toEqual([]);
  });

  it("list only routes that exist", () => {
    const routes = [...AGENTS_MD.matchAll(/`(\/api\/[^`]+)`/g)].map((m) => m[1]);
    expect(routes.length).toBeGreaterThan(5);
    for (const r of routes) {
      const dir = r.replace(/<id>/g, "[id]").replace(/<ticket_id>/g, "[ticketId]");
      expect(existsSync(path.join("app", dir, "route.ts")), r).toBe(true);
    }
  });
});
