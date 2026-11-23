import "server-only";
import { createDb } from "./client";
import type { AppDb } from "./types";
import { pooledDatabaseUrl } from "./urls";

// One pooled connection per server instance, reused across requests (and across
// hot reloads in development).
const globalForDb = globalThis as unknown as { __appDb?: AppDb };

export function getDb(): AppDb {
  if (!globalForDb.__appDb) {
    const url = pooledDatabaseUrl();
    if (!url) throw new Error("DATABASE_URL (or POSTGRES_URL) is not set");
    globalForDb.__appDb = createDb(url).db as unknown as AppDb;
  }
  return globalForDb.__appDb;
}
