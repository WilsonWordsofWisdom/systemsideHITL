import "dotenv/config";
import { defineConfig } from "drizzle-kit";

// Migrations use the direct (non-pooled) connection (decision 2026-11-21).
export default defineConfig({
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DIRECT_DATABASE_URL ?? "" },
  strict: true,
  verbose: true,
});
