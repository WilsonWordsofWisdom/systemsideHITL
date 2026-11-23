// Authorization codes with PKCE and access tokens (OAuth 2.1, MCP authorization
// spec; controls M1, M3). Codes are single use, bound to client, redirect URI, user,
// PKCE challenge and resource; a replayed code revokes the tokens issued from it.
// Access tokens are HS256 JWTs signed with a key derived from SESSION_SECRET: the
// issuer and the resource are the same app, so no published key set is needed,
// and rotating SESSION_SECRET invalidates every token.
import { createHash } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { SignJWT, jwtVerify } from "jose";
import { hmacBase64Url, randomToken, sha256Hex } from "../auth/crypto";
import { oauthCodes, oauthTokens } from "../db/schema";
import type { AppDb } from "../db/types";
import { ACCESS_TOKEN_TTL_SECONDS, CODE_TTL_SECONDS } from "./metadata";

// RFC 7636: 43-128 characters from the unreserved set.
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

export const validChallenge = (c: string | null | undefined) => !!c && CHALLENGE.test(c);

export function pkceS256(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function pkceMatches(verifier: string | null | undefined, challenge: string) {
  return !!verifier && VERIFIER.test(verifier) && pkceS256(verifier) === challenge;
}

export interface CodeGrant {
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource: string;
}

export async function issueCode(db: AppDb, grant: CodeGrant, now = new Date()) {
  const code = randomToken(32);
  await db.insert(oauthCodes).values({
    id: sha256Hex(code),
    ...grant,
    createdAt: now,
    expiresAt: new Date(now.getTime() + CODE_TTL_SECONDS * 1000),
  });
  return code;
}

export type TokenError = "invalid_grant" | "invalid_request" | "invalid_target";

// Redeems a code for an access token. The code is marked used in the same
// conditional update that checks it is unused and unexpired, so two concurrent
// redemptions can't both succeed.
export async function redeemCode(
  db: AppDb,
  input: {
    code: string | undefined;
    clientId: string | undefined;
    redirectUri: string | undefined;
    codeVerifier: string | undefined;
    resource: string | undefined;
  },
  keys: { secret: string; issuer: string; resource: string },
  now = new Date(),
): Promise<
  | { ok: true; accessToken: string; expiresIn: number; scope: string }
  | { ok: false; error: TokenError; description: string }
> {
  if (!input.code || !input.clientId || !input.redirectUri) {
    return {
      ok: false,
      error: "invalid_request",
      description: "code, client_id and redirect_uri are required.",
    };
  }
  if (input.resource && input.resource !== keys.resource) {
    return { ok: false, error: "invalid_target", description: "Unknown resource." };
  }
  const id = sha256Hex(input.code);
  const [row] = await db.select().from(oauthCodes).where(eq(oauthCodes.id, id)).limit(1);
  if (!row)
    return { ok: false, error: "invalid_grant", description: "Unknown authorization code." };
  if (row.usedAt) {
    // Replay: revoke anything issued from this code (OAuth 2.1 section 4.1.2).
    await db
      .update(oauthTokens)
      .set({ revokedAt: now })
      .where(and(eq(oauthTokens.codeId, id), isNull(oauthTokens.revokedAt)));
    return {
      ok: false,
      error: "invalid_grant",
      description: "The authorization code was already used.",
    };
  }
  if (row.expiresAt <= now)
    return { ok: false, error: "invalid_grant", description: "The authorization code expired." };
  if (row.clientId !== input.clientId || row.redirectUri !== input.redirectUri) {
    return {
      ok: false,
      error: "invalid_grant",
      description: "The code was issued to another client or redirect URI.",
    };
  }
  if (!pkceMatches(input.codeVerifier, row.codeChallenge)) {
    return {
      ok: false,
      error: "invalid_grant",
      description: "The PKCE code verifier does not match.",
    };
  }
  const [used] = await db
    .update(oauthCodes)
    .set({ usedAt: now })
    .where(and(eq(oauthCodes.id, id), isNull(oauthCodes.usedAt), gt(oauthCodes.expiresAt, now)))
    .returning({ id: oauthCodes.id });
  if (!used)
    return {
      ok: false,
      error: "invalid_grant",
      description: "The authorization code was already used.",
    };

  const jti = randomToken(16);
  const expiresAt = new Date(now.getTime() + ACCESS_TOKEN_TTL_SECONDS * 1000);
  await db.insert(oauthTokens).values({
    jti,
    clientId: row.clientId,
    userId: row.userId,
    codeId: id,
    scope: row.scope,
    createdAt: now,
    expiresAt,
  });
  const accessToken = await new SignJWT({
    scope: row.scope,
    client_id: row.clientId,
    // The agent acting for the user (RFC 8693 actor claim, control M3).
    act: { sub: row.clientId },
  })
    .setProtectedHeader({ alg: "HS256", typ: "at+jwt" })
    .setIssuer(keys.issuer)
    .setSubject(row.userId)
    .setAudience(row.resource)
    .setJti(jti)
    .setIssuedAt(Math.floor(now.getTime() / 1000))
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(signingKey(keys.secret));
  return { ok: true, accessToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS, scope: row.scope };
}

function signingKey(secret: string) {
  return new TextEncoder().encode(hmacBase64Url(secret, "oauth-access-token-signing-v1"));
}

export interface VerifiedToken {
  userId: string;
  clientId: string;
  scope: string;
  jti: string;
  expiresAt: Date;
}

// Verifies a bearer token for /mcp: signature (HS256 only), issuer, audience,
// expiry, actor claim, then that it was issued here and isn't revoked.
export async function verifyAccessToken(
  db: AppDb,
  token: string | null | undefined,
  keys: { secret: string; issuer: string; resource: string },
  now = new Date(),
): Promise<VerifiedToken | null> {
  if (!token) return null;
  let payload;
  try {
    ({ payload } = await jwtVerify(token, signingKey(keys.secret), {
      algorithms: ["HS256"],
      issuer: keys.issuer,
      audience: keys.resource,
      typ: "at+jwt",
      currentDate: now,
    }));
  } catch {
    return null;
  }
  const act = payload.act as { sub?: unknown } | undefined;
  if (
    !payload.sub ||
    !payload.jti ||
    typeof payload.client_id !== "string" ||
    act?.sub !== payload.client_id
  ) {
    return null;
  }
  const [row] = await db
    .select()
    .from(oauthTokens)
    .where(
      and(
        eq(oauthTokens.jti, payload.jti),
        isNull(oauthTokens.revokedAt),
        gt(oauthTokens.expiresAt, now),
      ),
    )
    .limit(1);
  if (!row || row.userId !== payload.sub || row.clientId !== payload.client_id) return null;
  return {
    userId: row.userId,
    clientId: row.clientId,
    scope: row.scope,
    jti: row.jti,
    expiresAt: row.expiresAt,
  };
}
