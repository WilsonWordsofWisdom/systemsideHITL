// The server-side session behind an MCP client (FR19, FR31). One row per OAuth
// client plus user, so the guard, tickets, risk state and console treat MCP calls
// like any other session, and a ticket stays redeemable by that client and user
// across token refreshes (decision 2026-11-21). The row ID comes from a keyed HMAC,
// so it can't be guessed, and validateSession refuses oauth_mcp rows as cookies.
import { hmacBase64Url, sha256Hex } from "../auth/crypto";
import type { SessionRow } from "../auth/session";
import { sessions } from "../db/schema";
import type { AppDb } from "../db/types";

export function mcpSessionId(secret: string, clientId: string, userId: string) {
  return sha256Hex(`mcp:${hmacBase64Url(secret, `mcp-session:${clientId}:${userId}`)}`);
}

export async function ensureMcpSession(
  db: AppDb,
  input: {
    secret: string;
    clientId: string;
    clientName: string;
    userId: string;
    tokenExpiresAt: Date;
    runId: string | null;
  },
  now = new Date(),
): Promise<SessionRow> {
  const id = mcpSessionId(input.secret, input.clientId, input.userId);
  const [row] = await db
    .insert(sessions)
    .values({
      id,
      userId: input.userId,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: input.tokenExpiresAt,
      declaredAgent: true,
      signinMethod: "oauth_mcp",
      // Tier A: the OAuth token names the client acting for the user (A1, M4).
      loginActorClass: "declared_agent",
      loginSignals: { client: { clientId: input.clientId, name: input.clientName } },
      runId: input.runId,
    })
    .onConflictDoUpdate({
      target: sessions.id,
      set: {
        lastSeenAt: now,
        expiresAt: input.tokenExpiresAt,
        ...(input.runId ? { runId: input.runId } : {}),
      },
    })
    .returning();
  return row;
}
