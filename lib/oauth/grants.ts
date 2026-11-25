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
import { oauthCodes, oauthRefreshTokens, oauthTokens } from "../db/schema";
import type { AppDb } from "../db/types";
import { ACCESS_TOKEN_TTL_SECONDS, CODE_TTL_SECONDS, REFRESH_TOKEN_TTL_SECONDS } from "./metadata";

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

export type TokenError = "invalid_grant" | "invalid_request" | "invalid_target" | "invalid_scope";

export interface TokenKeys {
  secret: string;
  issuer: string;
  // The resources this server serves; a code's resource must be one of them.
  resource: string | string[];
}

export type TokenResult =
  | { ok: true; accessToken: string; expiresIn: number; scope: string; refreshToken?: string }
  | { ok: false; error: TokenError; description: string };

const served = (keys: TokenKeys) =>
  Array.isArray(keys.resource) ? keys.resource : [keys.resource];

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
    // Poppy agents get a refresh token as well (FR45).
    issueRefresh?: boolean;
  },
  keys: TokenKeys,
  now = new Date(),
): Promise<TokenResult> {
  if (!input.code || !input.clientId || !input.redirectUri) {
    return {
      ok: false,
      error: "invalid_request",
      description: "code, client_id and redirect_uri are required.",
    };
  }
  if (input.resource && !served(keys).includes(input.resource)) {
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

  const accessToken = await mintAccessToken(db, { ...row, codeId: id }, keys, now);
  const refreshToken = input.issueRefresh
    ? await issueRefreshToken(db, { ...row, codeId: id }, now)
    : undefined;
  return {
    ok: true,
    accessToken,
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    scope: row.scope,
    ...(refreshToken ? { refreshToken } : {}),
  };
}

interface Grant {
  clientId: string;
  userId: string;
  codeId: string;
  scope: string;
  resource: string;
}

async function mintAccessToken(db: AppDb, g: Grant, keys: TokenKeys, now: Date) {
  const jti = randomToken(16);
  const expiresAt = new Date(now.getTime() + ACCESS_TOKEN_TTL_SECONDS * 1000);
  await db.insert(oauthTokens).values({
    jti,
    clientId: g.clientId,
    userId: g.userId,
    codeId: g.codeId,
    scope: g.scope,
    createdAt: now,
    expiresAt,
  });
  return new SignJWT({
    scope: g.scope,
    client_id: g.clientId,
    // The agent acting for the user (RFC 8693 actor claim, control M3).
    act: { sub: g.clientId },
  })
    .setProtectedHeader({ alg: "HS256", typ: "at+jwt" })
    .setIssuer(keys.issuer)
    .setSubject(g.userId)
    .setAudience(g.resource)
    .setJti(jti)
    .setIssuedAt(Math.floor(now.getTime() / 1000))
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(signingKey(keys.secret));
}

async function issueRefreshToken(db: AppDb, g: Grant, now: Date) {
  const token = `prt_${randomToken(32)}`;
  await db.insert(oauthRefreshTokens).values({
    id: sha256Hex(token),
    clientId: g.clientId,
    userId: g.userId,
    codeId: g.codeId,
    scope: g.scope,
    resource: g.resource,
    createdAt: now,
    expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000),
  });
  return token;
}

// Revokes a sign-in: every refresh and access token descended from its code
// (Poppy 5.5 sign-out, RFC 7009; control PP9).
export async function revokeFamily(db: AppDb, codeId: string, now = new Date()) {
  await db
    .update(oauthRefreshTokens)
    .set({ revokedAt: now })
    .where(and(eq(oauthRefreshTokens.codeId, codeId), isNull(oauthRefreshTokens.revokedAt)));
  await db
    .update(oauthTokens)
    .set({ revokedAt: now })
    .where(and(eq(oauthTokens.codeId, codeId), isNull(oauthTokens.revokedAt)));
}

// refresh_token grant with rotation (RFC 6749 section 6, Poppy 4.4). A refresh
// token works once; presenting a used one revokes the whole family (RFC 9700
// section 4.14.2). Scope can only narrow.
export async function refreshGrant(
  db: AppDb,
  input: { refreshToken: string | undefined; clientId: string; scope?: string; resource?: string },
  keys: TokenKeys,
  now = new Date(),
): Promise<TokenResult> {
  const invalid = (description: string): TokenResult => ({
    ok: false,
    error: "invalid_grant",
    description,
  });
  if (!input.refreshToken) {
    return { ok: false, error: "invalid_request", description: "refresh_token is required." };
  }
  const id = sha256Hex(input.refreshToken);
  const [row] = await db
    .select()
    .from(oauthRefreshTokens)
    .where(eq(oauthRefreshTokens.id, id))
    .limit(1);
  if (!row || row.clientId !== input.clientId) return invalid("Unknown refresh token.");
  if (row.revokedAt || row.expiresAt <= now)
    return invalid("The refresh token is no longer valid.");
  if (row.usedAt) {
    await revokeFamily(db, row.codeId, now);
    return invalid("The refresh token was already used.");
  }
  let scope = row.scope;
  if (input.scope) {
    const have = new Set(row.scope.split(" "));
    const asked = input.scope.split(" ").filter(Boolean);
    if (asked.length === 0 || asked.some((s) => !have.has(s))) {
      return { ok: false, error: "invalid_scope", description: "Scope can only narrow." };
    }
    scope = [...new Set(asked)].join(" ");
  }
  if (input.resource && !served(keys).includes(input.resource)) {
    return { ok: false, error: "invalid_target", description: "Unknown resource." };
  }
  const [used] = await db
    .update(oauthRefreshTokens)
    .set({ usedAt: now })
    .where(and(eq(oauthRefreshTokens.id, id), isNull(oauthRefreshTokens.usedAt)))
    .returning({ id: oauthRefreshTokens.id });
  if (!used) {
    await revokeFamily(db, row.codeId, now);
    return invalid("The refresh token was already used.");
  }
  const grant = {
    clientId: row.clientId,
    userId: row.userId,
    codeId: row.codeId,
    scope,
    resource: input.resource ?? row.resource,
  };
  const accessToken = await mintAccessToken(db, grant, keys, now);
  const refreshToken = await issueRefreshToken(
    db,
    { ...grant, resource: row.resource, scope: row.scope },
    now,
  );
  return { ok: true, accessToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS, scope, refreshToken };
}

// RFC 7009 revocation. A refresh token revokes its whole sign-in; an access token
// is revoked by its JWT ID. Unknown tokens, and other clients' tokens, change
// nothing (the endpoint answers 200 either way). Returns the revoked sign-in's code.
export async function revokeToken(
  db: AppDb,
  token: string | undefined,
  clientId: string,
  secret: string,
  now = new Date(),
): Promise<string | null> {
  if (!token) return null;
  const [refresh] = await db
    .select()
    .from(oauthRefreshTokens)
    .where(eq(oauthRefreshTokens.id, sha256Hex(token)))
    .limit(1);
  if (refresh) {
    if (refresh.clientId !== clientId) return null;
    await revokeFamily(db, refresh.codeId, now);
    return refresh.codeId;
  }
  try {
    const { payload } = await jwtVerify(token, signingKey(secret), {
      algorithms: ["HS256"],
      typ: "at+jwt",
      currentDate: now,
    });
    if (payload.client_id === clientId && typeof payload.jti === "string") {
      await db
        .update(oauthTokens)
        .set({ revokedAt: now })
        .where(and(eq(oauthTokens.jti, payload.jti), eq(oauthTokens.clientId, clientId)));
    }
  } catch {
    // Not a token we issued: nothing to do.
  }
  return null;
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
  // The sign-in this token descends from (null for tokens issued before Phase 7).
  codeId: string | null;
}

// Verifies a bearer token for /mcp: signature (HS256 only), issuer, audience,
// expiry, actor claim, then that it was issued here and isn't revoked.
export async function verifyAccessToken(
  db: AppDb,
  token: string | null | undefined,
  keys: TokenKeys,
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
    codeId: row.codeId,
  };
}
