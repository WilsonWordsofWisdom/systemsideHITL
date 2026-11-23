// Phase 0 step 2: migrations apply and the seed is idempotent (J12 "Seeding is repeatable").
// Runs against PGlite, an in-process Postgres, so no external database is needed.
import { PGlite } from "@electric-sql/pglite";
import { count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "@/lib/db/schema";
import { DEMO_USER_ID, SECOND_USER_ID, seed } from "@/scripts/seed";

const client = new PGlite();
const db = drizzle(client, { schema });
const password = "test-password-" + Math.random().toString(36).slice(2);

beforeAll(async () => {
  await migrate(db, { migrationsFolder: "./drizzle" });
});
afterAll(async () => {
  await client.close();
});

async function counts() {
  const [u] = await db.select({ n: count() }).from(schema.users);
  const [a] = await db.select({ n: count() }).from(schema.applications);
  const [demo] = await db
    .select({ n: count() })
    .from(schema.applications)
    .where(eq(schema.applications.userId, DEMO_USER_ID));
  const [second] = await db
    .select({ n: count() })
    .from(schema.applications)
    .where(eq(schema.applications.userId, SECOND_USER_ID));
  return { users: u.n, applications: a.n, demo: demo.n, second: second.n };
}

describe("database", () => {
  it("enables row-level security on every table (control D3)", async () => {
    const { rows } = await client.query<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and c.relname not like '\\_\\_%'`,
    );
    expect(rows.map((r) => r.relname).sort()).toEqual([
      "applications",
      "client_signals",
      "hitl_tickets",
      "mcp_clients",
      "oauth_codes",
      "oauth_tokens",
      "passkeys",
      "rate_limits",
      "request_log",
      "runs",
      "session_events",
      "sessions",
      "users",
      "webauthn_challenges",
    ]);
    expect(rows.filter((r) => !r.relrowsecurity).map((r) => r.relname)).toEqual([]);
  });

  it("refuses to seed without a strong enough password", async () => {
    await expect(seed(db, undefined)).rejects.toThrow(/DEMO_USER_PASSWORD/);
    await expect(seed(db, "short")).rejects.toThrow(/DEMO_USER_PASSWORD/);
  });

  it("seeds two users and four applications, and is idempotent", async () => {
    await seed(db, password);
    const first = await counts();
    await seed(db, password);
    const second = await counts();
    expect(first).toEqual({ users: 2, applications: 4, demo: 3, second: 1 });
    expect(second).toEqual(first);
  });

  it("stores an argon2id hash, never the password itself", async () => {
    const rows = await db.select({ h: schema.users.passwordHash }).from(schema.users);
    for (const { h } of rows) {
      expect(h.startsWith("$argon2id$")).toBe(true);
      expect(h).not.toContain(password);
    }
  });
});

describe(".env.example", () => {
  it("leaves every secret empty", () => {
    const env = readFileSync(".env.example", "utf8");
    for (const name of [
      "DATABASE_URL",
      "DIRECT_DATABASE_URL",
      "SESSION_SECRET",
      "ADMIN_SECRET",
      "DEMO_USER_PASSWORD",
    ]) {
      expect(env).toMatch(new RegExp(`^${name}=$`, "m"));
    }
  });
});
