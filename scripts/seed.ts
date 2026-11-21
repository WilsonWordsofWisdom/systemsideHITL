// Seeds the demo accounts and past applications. Safe to run repeatedly:
// fixed IDs make every insert idempotent, and passwords are re-hashed from the
// environment so a rotated DEMO_USER_PASSWORD takes effect on the next run.
import { hash } from "@node-rs/argon2";
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { applications, users } from "../lib/db/schema";

// Accepts the postgres-js database in production and PGlite in tests.
type SeedDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export const DEMO_USER_ID = "00000000-0000-4000-8000-000000000001";
export const SECOND_USER_ID = "00000000-0000-4000-8000-000000000002";

const seedUsers = [
  { id: DEMO_USER_ID, email: "demo@demogov.test", name: "Demo User" },
  { id: SECOND_USER_ID, email: "second@demogov.test", name: "Second User" },
];

const seedApplications = [
  {
    id: "00000000-0000-4000-8000-000000000101",
    userId: DEMO_USER_ID,
    status: "paid" as const,
    title: "Summer Street Fair",
    details: { date: "2026-06-20", attendance: 300, location: "High Street" },
    submittedAt: new Date("2026-05-02T10:00:00Z"),
    paidAt: new Date("2026-05-02T10:05:00Z"),
  },
  {
    id: "00000000-0000-4000-8000-000000000102",
    userId: DEMO_USER_ID,
    status: "submitted" as const,
    title: "Autumn Craft Market",
    details: { date: "2026-10-10", attendance: 120, location: "Town Hall car park" },
    submittedAt: new Date("2026-09-01T09:30:00Z"),
    paidAt: null,
  },
  {
    id: "00000000-0000-4000-8000-000000000103",
    userId: DEMO_USER_ID,
    status: "draft" as const,
    title: "Winter Lights Walk",
    details: { date: "2026-12-18", attendance: 60, location: "Riverside Park" },
    submittedAt: null,
    paidAt: null,
  },
  {
    id: "00000000-0000-4000-8000-000000000201",
    userId: SECOND_USER_ID,
    status: "paid" as const,
    title: "Neighbourhood Garage Sale",
    details: { date: "2026-08-08", attendance: 40, location: "Elm Close" },
    submittedAt: new Date("2026-07-15T14:00:00Z"),
    paidAt: new Date("2026-07-15T14:10:00Z"),
  },
];

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
