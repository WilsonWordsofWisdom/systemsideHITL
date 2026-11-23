// End-to-end test database settings, read only from .env.test.local (never the
// app's .env.local). The tests reset this database on every run, so it must be a
// separate Supabase project; a guard refuses to run against production.
import { parse } from "dotenv";
import { existsSync, readFileSync } from "node:fs";

export const E2E_PORT = 3100;
export const E2E_ORIGIN = `http://localhost:${E2E_PORT}`;
export const E2E_DEMO_PASSWORD = "e2e-demo-password-123";
// Test-only console secret for the local e2e server; not used anywhere else.
export const E2E_ADMIN_SECRET = "e2e-admin-secret-0123456789";

function readEnvFile(path: string): Record<string, string> {
  return existsSync(path) ? parse(readFileSync(path)) : {};
}

// Identifies a Supabase database: pooler host plus user (which carries the project ref).
function identity(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.hostname}|${decodeURIComponent(u.username)}`;
  } catch {
    return null;
  }
}

// Supabase connections always use TLS, even if the copied URI omitted sslmode.
function withTls(url: string | undefined): string | undefined {
  if (!url) return url;
  try {
    const u = new URL(url);
    if (u.hostname.endsWith(".supabase.com") && !u.searchParams.has("sslmode")) {
      u.searchParams.set("sslmode", "require");
    }
    return u.toString();
  } catch {
    return url;
  }
}

// Local Postgres from docker-compose.e2e.yml (decision 2026-11-23). Bound to
// 127.0.0.1 only and holding throwaway seed data, so this password is not a secret.
export const LOCAL_E2E_URL = "postgres://hitl_e2e:hitl_e2e_local@127.0.0.1:54329/hitl_e2e";

// E2E_TARGET=local (default) uses the Docker database; E2E_TARGET=supabase uses
// the separate Supabase test project from .env.test.local.
export function e2eDatabase() {
  const target = process.env.E2E_TARGET ?? "local";
  if (target === "local") return { pooled: LOCAL_E2E_URL, direct: LOCAL_E2E_URL };
  if (target !== "supabase") throw new Error('E2E_TARGET must be "local" or "supabase"');
  const test = readEnvFile(".env.test.local");
  const pooled = withTls(test.E2E_DATABASE_URL || test.POSTGRES_URL);
  const direct = withTls(test.E2E_DIRECT_DATABASE_URL || test.POSTGRES_URL_NON_POOLING);
  if (!pooled || !direct) {
    throw new Error(
      "End-to-end tests need a separate Supabase test database: put its POSTGRES_URL and " +
        "POSTGRES_URL_NON_POOLING in .env.test.local (see docs/decisions.md).",
    );
  }
  const prod = readEnvFile(".env.local");
  const prodIds = [prod.POSTGRES_URL, prod.POSTGRES_URL_NON_POOLING, prod.DATABASE_URL]
    .map(identity)
    .filter(Boolean);
  for (const url of [pooled, direct]) {
    if (prodIds.includes(identity(url))) {
      throw new Error(
        "Refusing to run: .env.test.local points at the same database as .env.local.",
      );
    }
  }
  return { pooled, direct };
}

// Environment for an app server under test. Variant servers (tests/e2e/variant.ts)
// start from this and override the experiment flags.
export function e2eAppEnv(origin: string): Record<string, string> {
  const db = e2eDatabase();
  return {
    DATABASE_URL: db.pooled,
    DIRECT_DATABASE_URL: db.direct,
    DB_POOL_MAX: "3",
    APP_ORIGIN: origin,
    RP_ID: "localhost",
    SESSION_SECRET: "e2e-session-secret-0123456789abcdef",
    HITL_MODE: "enforce",
    AGENT_HINTS: "off",
    SELF_DECLARE_UI: "on",
    // Open so the e2e suite can enrol a virtual passkey; the closed state is unit-tested.
    PASSKEY_ENROLMENT: "open",
    ADMIN_SECRET: E2E_ADMIN_SECRET,
  };
}
