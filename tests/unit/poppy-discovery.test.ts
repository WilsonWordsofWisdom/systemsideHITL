// Poppy discovery, tasks and version rules (J13 T16, FR42, controls PP1, PP2), and
// the Retry-After value used on every 429.
import { describe, expect, it } from "vitest";
import { findModelDirectedText } from "@/lib/content";
import { poppyOn } from "@/lib/flags";
import { getPolicy, parsePolicy } from "@/lib/hitl/policy";
import { excludedActions, poppyDocument, tasksResponse } from "@/lib/poppy/discovery";
import { versionCompatible } from "@/lib/poppy/version";
import { retryAfter } from "@/lib/ratelimit";

const ORIGIN = "https://hitltest.vercel.app";

const urlsIn = (value: unknown): string[] =>
  JSON.stringify(value)
    .match(/"(https?:\/\/[^"]+)"/g)
    ?.map((s) => s.slice(1, -1)) ?? [];

describe("POPPY flag", () => {
  it("is on only when set exactly to on", () => {
    for (const v of [undefined, "", "off", "true", "ON"]) expect(poppyOn({ POPPY: v })).toBe(false);
    expect(poppyOn({ POPPY: "on" })).toBe(true);
  });
});

describe("Poppy-Version", () => {
  it.each([
    ["1.0", true],
    ["1.1", true],
    ["1.10", true],
    ["2.0", false],
    ["0.4", false],
    ["1", false],
    ["", false],
    ["1.0; x", false],
  ])("%j compatible: %s", (value, ok) => {
    expect(versionCompatible(value)).toBe(ok);
  });
});

describe("poppy.json", () => {
  const doc = poppyDocument(ORIGIN, getPolicy());

  it("names this host as the organization domain and protocol 1.0", () => {
    expect(doc.protocol_version).toBe("1.0");
    expect(doc.organization).toEqual({
      name: "DemoGov Permits (prototype)",
      domain: "hitltest.vercel.app",
    });
    expect(poppyDocument("http://localhost:3107", getPolicy()).organization.domain).toBe(
      "localhost:3107",
    );
  });

  it("declares sign-in, the website, tasks and Operations", () => {
    expect(Object.keys(doc).sort()).toEqual([
      "apis",
      "auth",
      "extensions",
      "organization",
      "protocol_version",
      "tasks",
      "web",
    ]);
    expect(doc.web).toEqual({
      browser_session_endpoint: `${ORIGIN}/poppy/join`,
      unscoped: true,
    });
    expect(doc.apis).toEqual([expect.objectContaining({ type: "mcp", url: `${ORIGIN}/mcp` })]);
    // Operations v3 without a website endpoint (that needs browser join, slice C).
    expect(doc.extensions).toEqual({ operations: [{ version: "3" }] });
  });

  it("describes every scope and gives each a hint derived from the policy", () => {
    const scopes = Object.keys(doc.auth.scopes);
    expect(Object.keys(doc.auth.scope_hints).sort()).toEqual([...scopes].sort());
    expect(doc.auth.scope_hints["applications:read"]).toEqual({
      changes: "none",
      personal_data: true,
    });
    expect(doc.auth.scope_hints["applications:write"].changes).toBe("reversible");
    for (const s of [
      "applications:submit",
      "applications:delete",
      "payments",
      "poppy:browser-sign-in",
    ]) {
      expect(doc.auth.scope_hints[s].changes, s).toBe("irreversible");
    }
    expect(findModelDirectedText(JSON.stringify(doc.auth))).toEqual([]);
  });

  it("uses HTTPS URLs on this host only", () => {
    const urls = urlsIn(doc);
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect(new URL(u).origin).toBe(ORIGIN);
  });
});

describe("tasks endpoint", () => {
  const body = tasksResponse(ORIGIN, getPolicy());

  it("excludes exactly the actions the policy denies to declared agents", () => {
    expect(excludedActions(getPolicy())).toEqual(["update_contact"]);
    expect(body.excluded_tasks).toEqual([
      {
        task: "Change the recovery email or phone",
        alternative: {
          instructions: expect.stringContaining("The account holder changes"),
          references: [{ type: "web", url: `${ORIGIN}/account/contact` }],
        },
      },
    ]);
    expect(body.feedback).toEqual({ endpoint: `${ORIGIN}/api/poppy/feedback` });
  });

  it("is declarative and on this host", () => {
    expect(findModelDirectedText(JSON.stringify(body))).toEqual([]);
    for (const u of urlsIn(body)) expect(new URL(u).origin).toBe(ORIGIN);
  });

  it("refuses to describe an excluded action it has no text for", () => {
    const policy = parsePolicy(`
version: 1
read_only: []
actions:
  close_account: { human: gate, declared_agent: deny, suspected_agent: deny, unknown: gate }
critical: []
gate: { ttl_seconds: 600, methods: [passkey], human_fresh_auth_skip_seconds: 0 }
`);
    expect(() => tasksResponse(ORIGIN, policy)).toThrow(/close_account/);
  });
});

describe("retryAfter", () => {
  const now = new Date("2026-12-01T09:00:00Z");
  it("counts whole seconds until the lock ends, at least 1", () => {
    expect(retryAfter(new Date(now.getTime() + 59_200), now, 600)).toBe("60");
    expect(retryAfter(new Date(now.getTime() - 5_000), now, 600)).toBe("1");
  });
  it("falls back to the rule's lock length", () => {
    expect(retryAfter(null, now, 600)).toBe("600");
  });
});
