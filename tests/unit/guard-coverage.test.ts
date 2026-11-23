// Route coverage (controls C1, C4; J07 "A mutating route without a policy entry
// fails the build"). Every mutating API route must go through journeyAction, which
// calls hitlGuard, and name an action the policy lists. Routes that are not
// journey actions are listed here by name with the reason they are exempt.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getPolicy } from "@/lib/hitl/policy";
import { hasSnapshot } from "@/lib/hitl/snapshot";

const EXEMPT: Record<string, string> = {
  "app/api/auth/login/route.ts": "sign-in: creates the session the guard needs",
  "app/api/auth/logout/route.ts": "sign-out: only ends the caller's own session",
  "app/api/auth/passkey/options/route.ts": "sign-in challenge",
  "app/api/auth/passkey/verify/route.ts": "sign-in",
  "app/api/passkeys/register/options/route.ts":
    "enrolment: gated by PASSKEY_ENROLMENT and audited (W7)",
  "app/api/passkeys/register/verify/route.ts":
    "enrolment: gated by PASSKEY_ENROLMENT and audited (W7)",
  "app/api/signals/route.ts": "classifier input only; changes no journey state",
  "app/api/hitl/[ticketId]/webauthn/options/route.ts":
    "approval challenge: the human's side of the gate, checked by approveContext",
  "app/api/hitl/[ticketId]/approve/route.ts":
    "approval: needs the ticket's user and a UV passkey assertion (FR20)",
  "app/api/hitl/[ticketId]/reject/route.ts": "decline: the ticket's user only, by approveContext",
};

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return routeFiles(full);
    return name === "route.ts" ? [full] : [];
  });
}

const MUTATING = /export\s+(?:async\s+function|const)\s+(POST|PUT|PATCH|DELETE)\b/g;

const routes = routeFiles("app/api").map((file) => {
  const source = readFileSync(file, "utf8");
  return {
    file: file.split(path.sep).join("/"),
    source,
    methods: [...source.matchAll(MUTATING)].map((m) => m[1]),
    actions: [...source.matchAll(/action:\s*"([a-z_]+)"/g)].map((m) => m[1]),
  };
});

describe("every mutating route is guarded", () => {
  const mutating = routes.filter((r) => r.methods.length > 0 && !(r.file in EXEMPT));

  it("finds the journey routes", () => {
    expect(mutating.length).toBeGreaterThanOrEqual(8);
  });

  it.each(mutating.map((r) => [r.file, r] as const))("%s goes through journeyAction", (_f, r) => {
    expect(r.source).toContain("journeyAction(");
    expect(r.actions.length).toBeGreaterThan(0);
  });

  it.each(mutating.map((r) => [r.file, r] as const))("%s names only listed actions", (_f, r) => {
    const policy = getPolicy();
    for (const action of r.actions) {
      expect(policy.isListed(action), `${r.file}: ${action} has no policy entry`).toBe(true);
    }
  });

  it("the exemption list names only files that exist and mutate", () => {
    for (const file of Object.keys(EXEMPT)) {
      const route = routes.find((r) => r.file === file);
      expect(route, file).toBeDefined();
      expect(route!.methods.length, file).toBeGreaterThan(0);
    }
  });
});

describe("policy and routes agree", () => {
  it("every action in the policy is used by a route", () => {
    const used = new Set(routes.flatMap((r) => r.actions));
    for (const action of Object.keys(getPolicy().data.actions)) {
      expect(used.has(action), `${action} is in the policy but no route uses it`).toBe(true);
    }
  });

  it("every action the policy can gate has a resource snapshot builder", () => {
    for (const [action, row] of Object.entries(getPolicy().data.actions)) {
      if (Object.values(row).includes("gate")) expect(hasSnapshot(action), action).toBe(true);
    }
  });

  it("journeyAction calls hitlGuard before running the action", () => {
    const handler = readFileSync("lib/journey/handler.ts", "utf8");
    const guardAt = handler.indexOf("await hitlGuard(");
    const runAt = handler.indexOf("await opts.run(");
    expect(guardAt).toBeGreaterThan(0);
    expect(runAt).toBeGreaterThan(guardAt);
  });
});
