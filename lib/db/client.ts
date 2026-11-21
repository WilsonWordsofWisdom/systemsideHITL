import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

// The app uses Supabase's transaction pooler, which does not support prepared
// statements, so they are turned off (decision 2026-11-21, control D6).
export function createDb(url: string) {
  const client = postgres(url, { prepare: false });
  return { db: drizzle(client, { schema }), close: () => client.end() };
}

export type Db = ReturnType<typeof createDb>["db"];
