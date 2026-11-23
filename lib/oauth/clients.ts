// Dynamic client registration (RFC 7591, control M2). Public clients only. Redirect
// URIs must be HTTPS, or HTTP on a loopback address for native and CLI clients,
// with no fragment; they are matched exactly at authorization time.
import { OAuthClientMetadataSchema } from "@modelcontextprotocol/core";
import { eq } from "drizzle-orm";
import { randomToken } from "../auth/crypto";
import { mcpClients } from "../db/schema";
import type { AppDb } from "../db/types";

export type McpClient = typeof mcpClients.$inferSelect;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MAX_REDIRECT_URIS = 5;

export function redirectUriProblem(uri: string): string | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return "not a valid URL";
  }
  if (url.hash) return "must not contain a fragment";
  if (url.username || url.password) return "must not contain credentials";
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return null;
  return "must use https, or http on a loopback address";
}

export class RegistrationError extends Error {
  constructor(
    readonly error: "invalid_redirect_uri" | "invalid_client_metadata",
    readonly description: string,
  ) {
    super(description);
  }
}

export async function registerClient(db: AppDb, raw: unknown, now = new Date()) {
  const parsed = OAuthClientMetadataSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RegistrationError("invalid_client_metadata", "The client metadata is not valid.");
  }
  const meta = parsed.data;
  const uris = meta.redirect_uris;
  if (uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
    throw new RegistrationError(
      "invalid_redirect_uri",
      `Register 1 to ${MAX_REDIRECT_URIS} redirect URIs.`,
    );
  }
  for (const uri of uris) {
    const problem = redirectUriProblem(uri);
    if (problem) throw new RegistrationError("invalid_redirect_uri", `Redirect URI ${problem}.`);
  }
  if (meta.token_endpoint_auth_method && meta.token_endpoint_auth_method !== "none") {
    throw new RegistrationError(
      "invalid_client_metadata",
      "Only public clients are supported (token_endpoint_auth_method: none).",
    );
  }
  if (meta.grant_types && meta.grant_types.some((g) => g !== "authorization_code")) {
    throw new RegistrationError("invalid_client_metadata", "Only authorization_code is supported.");
  }
  // The name is shown on the consent screen: keep it short and plain.
  const name =
    (meta.client_name ?? "Unnamed MCP client")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim()
      .slice(0, 80) || "Unnamed MCP client";
  const [client] = await db
    .insert(mcpClients)
    .values({ clientId: `mcp_${randomToken(16)}`, name, redirectUris: uris, registeredAt: now })
    .returning();
  return {
    client_id: client.clientId,
    client_id_issued_at: Math.floor(now.getTime() / 1000),
    client_name: client.name,
    redirect_uris: client.redirectUris,
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

export async function getClient(db: AppDb, clientId: string | null | undefined) {
  if (!clientId || clientId.length > 100) return null;
  const [client] = await db
    .select()
    .from(mcpClients)
    .where(eq(mcpClients.clientId, clientId))
    .limit(1);
  return client ?? null;
}
