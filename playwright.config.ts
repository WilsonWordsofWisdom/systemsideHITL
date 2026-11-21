import { defineConfig } from "@playwright/test";

const PORT = 3100;

export default defineConfig({
  testDir: "tests/e2e",
  forbidOnly: !!process.env.CI,
  retries: 0,
  use: { baseURL: `http://localhost:${PORT}` },
  // Uses the installed Google Chrome locally; CI installs a browser instead.
  projects: [{ name: "chrome", use: { channel: process.env.CI ? undefined : "chrome" } }],
  webServer: {
    // A production build, not `next dev`, so tests match what Vercel serves.
    command: `npm run build && npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
  },
});
