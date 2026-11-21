import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";
import { directDatabaseUrl } from "./lib/db/urls";

// Local secrets live in .env.local (Vercel's snippet) or .env; neither is committed.
config({ path: [".env.local", ".env"], quiet: true });

// Migrations use the direct (non-pooled) connection (decision 2026-11-21).
export default defineConfig({
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: directDatabaseUrl() ?? "" },
  strict: true,
  verbose: true,
});
