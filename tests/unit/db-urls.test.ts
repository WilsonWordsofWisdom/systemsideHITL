import { describe, expect, it } from "vitest";
import { directDatabaseUrl, pooledDatabaseUrl } from "@/lib/db/urls";

describe("database URLs", () => {
  it("prefers our own variable names", () => {
    const env = {
      DATABASE_URL: "postgres://ours-pooled",
      POSTGRES_URL: "postgres://vercel-pooled",
      DIRECT_DATABASE_URL: "postgres://ours-direct",
      POSTGRES_URL_NON_POOLING: "postgres://vercel-direct",
    };
    expect(pooledDatabaseUrl(env)).toBe("postgres://ours-pooled");
    expect(directDatabaseUrl(env)).toBe("postgres://ours-direct");
  });

  it("falls back to the variables Vercel adds for Supabase", () => {
    const env = {
      POSTGRES_URL: "postgres://vercel-pooled",
      POSTGRES_URL_NON_POOLING: "postgres://vercel-direct",
    };
    expect(pooledDatabaseUrl(env)).toBe("postgres://vercel-pooled");
    expect(directDatabaseUrl(env)).toBe("postgres://vercel-direct");
  });

  it("treats empty values as unset", () => {
    expect(pooledDatabaseUrl({ DATABASE_URL: " ", POSTGRES_URL: "" })).toBeUndefined();
    expect(directDatabaseUrl({})).toBeUndefined();
  });
});
