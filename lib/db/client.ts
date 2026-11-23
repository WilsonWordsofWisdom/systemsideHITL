import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

// Connection settings for Supabase's poolers (decision 2026-11-23).
// - prepare: the transaction pooler does not support prepared statements
//   (decision 2026-11-21, control D6).
// - idle_timeout: the pooler path drops connections idle for about a minute
//   without telling the client; a query on such a socket hung for ~285 s before
//   ECONNRESET. Closing idle connections ourselves after 20 s avoids reusing them.
// - max_lifetime: recycle long-lived connections for the same reason.
// - connect_timeout: fail fast instead of hanging when the pooler is unreachable.
export const POOL_OPTIONS = {
  prepare: false,
  idle_timeout: 20,
  max_lifetime: 5 * 60,
  connect_timeout: 10,
} as const;

// DB_POOL_MAX keeps the pool small per serverless instance and in tests.
export function createDb(url: string) {
  const max = Number(process.env.DB_POOL_MAX ?? 5);
  const client = postgres(url, {
    ...POOL_OPTIONS,
    max: Number.isInteger(max) && max > 0 ? max : 5,
  });
  return { db: drizzle(client, { schema }), close: () => client.end() };
}

export type Db = ReturnType<typeof createDb>["db"];
