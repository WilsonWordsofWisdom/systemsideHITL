import { defineConfig } from "@playwright/test";
import { E2E_ORIGIN, E2E_PORT, e2eDatabase } from "./tests/e2e/env";

// End-to-end tests run against a production build and a separate Supabase test
// database (from .env.test.local), never the production database.
const db = e2eDatabase();

const appEnv = {
  DATABASE_URL: db.pooled,
  DIRECT_DATABASE_URL: db.direct,
  DB_POOL_MAX: "3",
  APP_ORIGIN: E2E_ORIGIN,
  RP_ID: "localhost",
  SESSION_SECRET: "e2e-session-secret-0123456789abcdef",
  HITL_MODE: "enforce",
  AGENT_HINTS: "off",
  SELF_DECLARE_UI: "on",
  // Open so the e2e suite can enrol a virtual passkey; the closed state is unit-tested.
  PASSKEY_ENROLMENT: "open",
};

export default defineConfig({
  testDir: "tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  forbidOnly: !!process.env.CI,
  retries: 0,
  // Tests share one database, so they run one at a time for deterministic results.
  workers: 1,
  fullyParallel: false,
  use: { baseURL: E2E_ORIGIN },
  // Uses the installed Google Chrome locally; CI installs a browser instead.
  projects: [{ name: "chrome", use: { channel: process.env.CI ? undefined : "chrome" } }],
  webServer: {
    // A production build, not `next dev`, so tests match what Vercel serves.
    command: `npm run build && npx next start -p ${E2E_PORT}`,
    url: E2E_ORIGIN,
    env: appEnv,
    reuseExistingServer: false,
    timeout: 240_000,
  },
});
