// End-to-end test database settings, read only from .env.test.local (never the
// app's .env.local). The tests reset this database on every run, so it must be a
// separate Supabase project; a guard refuses to run against production.
import { parse } from "dotenv";
import { existsSync, readFileSync } from "node:fs";

export const E2E_PORT = 3100;
export const E2E_ORIGIN = `http://localhost:${E2E_PORT}`;
export const E2E_DEMO_PASSWORD = "e2e-demo-password-123";

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

export function e2eDatabase() {
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
