import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type * as schema from "./schema";

// One database type for the app (postgres-js) and tests (PGlite).
export type AppDb = PgDatabase<PgQueryResultHKT, typeof schema>;
