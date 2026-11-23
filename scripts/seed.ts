// Seeds the demo accounts and past applications. Safe to run repeatedly:
// fixed IDs make every insert idempotent, and passwords are re-hashed from the
// environment so a rotated DEMO_USER_PASSWORD takes effect on the next run.
import { hash } from "@node-rs/argon2";
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { applications, users } from "../lib/db/schema";
import { DEMO_USER_ID, SECOND_USER_ID, seedApplications, seedUsers } from "../lib/db/seed-data";

// Accepts the postgres-js database in production and PGlite in tests.
type SeedDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export { DEMO_USER_ID, SECOND_USER_ID };

export async function seed(db: SeedDb, password: string | undefined) {
  if (!password || password.length < 12) {
    throw new Error("DEMO_USER_PASSWORD must be set and at least 12 characters");
  }
  const passwordHash = await hash(password); // argon2id by default.

  for (const u of seedUsers) {
    await db
      .insert(users)
      .values({ ...u, passwordHash })
      .onConflictDoUpdate({ target: users.id, set: { passwordHash: sql`excluded.password_hash` } });
  }
  await db.insert(applications).values(seedApplications).onConflictDoNothing();
}

async function main() {
  const { config } = await import("dotenv");
  config({ path: [".env.local", ".env"], quiet: true });
  const { directDatabaseUrl } = await import("../lib/db/urls");
  const url = directDatabaseUrl();
  if (!url) throw new Error("DIRECT_DATABASE_URL or POSTGRES_URL_NON_POOLING is required to seed");
  const { createDb } = await import("../lib/db/client");
  const { db, close } = createDb(url);
  try {
    await seed(db as unknown as SeedDb, process.env.DEMO_USER_PASSWORD);
    console.log("Seed complete");
  } finally {
    await close();
  }
}

if (process.argv[1]?.endsWith("seed.ts")) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
