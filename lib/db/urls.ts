// Database connection strings. Our own names win; otherwise fall back to the
// variables Vercel adds when Supabase is connected from its Storage tab
// (decision 2026-11-21): POSTGRES_URL is pooled, POSTGRES_URL_NON_POOLING is direct.
import type { EnvSource } from "../config";

export function pooledDatabaseUrl(env: EnvSource = process.env): string | undefined {
  return env.DATABASE_URL?.trim() || env.POSTGRES_URL?.trim() || undefined;
}

export function directDatabaseUrl(env: EnvSource = process.env): string | undefined {
  return env.DIRECT_DATABASE_URL?.trim() || env.POSTGRES_URL_NON_POOLING?.trim() || undefined;
}
