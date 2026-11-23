// Before each end-to-end run: migrate the test database, empty every app table
// and re-seed, so results don't depend on earlier runs.
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "../../lib/db/schema";
import { seed } from "../../scripts/seed";
import { E2E_DEMO_PASSWORD, e2eDatabase } from "./env";

export default async function globalSetup() {
  const { direct } = e2eDatabase();
  const sql = postgres(direct, { prepare: false, max: 1, connect_timeout: 10 });
  try {
    await sql`select 1`.catch((err) => {
      throw new Error(
        `The e2e database is not reachable (${(err as Error).message}). For the default local ` +
          "database, start Docker Desktop and run `npm run e2e:db:up`.",
      );
    });
    const db = drizzle(sql, { schema });
    await migrate(db, { migrationsFolder: "./drizzle" });
    const tables = await sql<{ tablename: string }[]>`
      select tablename from pg_tables where schemaname = 'public'`;
    if (tables.length > 0) {
      await sql.unsafe(
        `truncate table ${tables.map((t) => `"public"."${t.tablename}"`).join(", ")} cascade`,
      );
    }
    await seed(db as never, E2E_DEMO_PASSWORD);
  } finally {
    await sql.end();
  }
}
