// A fresh, migrated in-process Postgres (PGlite) per test file.
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/lib/db/schema";
import type { AppDb } from "@/lib/db/types";
import { seed } from "@/scripts/seed";

export async function createTestDb(options: { seed?: boolean } = {}) {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: "./drizzle" });
  if (options.seed) await seed(db, "test-password-123456");
  return { client, db: db as unknown as AppDb, close: () => client.close() };
}
