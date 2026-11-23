import { defineConfig } from "@playwright/test";
import { E2E_ORIGIN, E2E_PORT, e2eAppEnv } from "./tests/e2e/env";

// End-to-end tests run against a production build and a test database (local
// Docker by default, or the Supabase test project), never the production database.
const appEnv = e2eAppEnv(E2E_ORIGIN);

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
