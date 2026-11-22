import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

// The app uses Supabase's transaction pooler, which does not support prepared
// statements, so they are turned off (decision 2026-11-21, control D6).
// DB_POOL_MAX keeps the pool small per serverless instance and in tests.
export function createDb(url: string) {
  const max = Number(process.env.DB_POOL_MAX ?? 5);
  const client = postgres(url, {
    prepare: false,
    max: Number.isInteger(max) && max > 0 ? max : 5,
  });
  return { db: drizzle(client, { schema }), close: () => client.end() };
}

export type Db = ReturnType<typeof createDb>["db"];
