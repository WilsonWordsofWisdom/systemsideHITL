// Signed JWTs from Poppy agents: client assertions (private_key_jwt, RFC 7523) and
// the replay cache shared with Session JWTs (Poppy 1.0 sections 4.2, 5.3; controls
// PP5, PP7). Only ES256 and PS384 are accepted; `none` and HMAC never are.
import { createLocalJWKSet, jwtVerify, type JWTPayload } from "jose";
import { lt } from "drizzle-orm";
import { poppyJtis } from "@/lib/db/schema";
import type { AppDb } from "@/lib/db/types";
import type { AgentMetadata, PublicJwk } from "./agent-metadata";

export const AGENT_ALGS = ["ES256", "PS384"];
export const CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
const MAX_ASSERTION_SECONDS = 300;

// Records a JWT ID until it expires; false when it was already seen (a replay).
export async function firstUse(db: AppDb, key: string, until: Date, now = new Date()) {
  await db.delete(poppyJtis).where(lt(poppyJtis.expiresAt, now));
  const rows = await db
    .insert(poppyJtis)
    .values({ key: key.slice(0, 600), expiresAt: until })
    .onConflictDoNothing()
    .returning({ key: poppyJtis.key });
  return rows.length === 1;
}

export type KeySource = (jwksUri: string, kid?: string) => Promise<PublicJwk[]>;

// Verifies a client assertion for the token or revocation endpoint. Returns null
// when it fails any check.
export async function verifyClientAssertion(
  db: AppDb,
  assertion: string | undefined,
  client: AgentMetadata,
  issuer: string,
  keys: KeySource,
  now = new Date(),
): Promise<JWTPayload | null> {
  if (!assertion || assertion.length > 8192) return null;
  try {
    const kid = JSON.parse(Buffer.from(assertion.split(".")[0], "base64url").toString()).kid;
    const jwks = createLocalJWKSet({ keys: await keys(client.jwksUri, kid) });
    const { payload } = await jwtVerify(assertion, jwks, {
      algorithms: AGENT_ALGS,
      issuer: client.clientId,
      subject: client.clientId,
      currentDate: now,
      clockTolerance: 30,
    });
    // aud must be exactly the issuer, as a single string (Poppy 4.2).
    if (payload.aud !== issuer) return null;
    if (typeof payload.jti !== "string" || !payload.jti || typeof payload.iat !== "number") {
      return null;
    }
    if (typeof payload.exp !== "number" || payload.exp - payload.iat > MAX_ASSERTION_SECONDS) {
      return null;
    }
    const until = new Date(payload.exp * 1000 + 30_000);
    if (!(await firstUse(db, `assertion:${client.clientId}:${payload.jti}`, until, now)))
      return null;
    return payload;
  } catch {
    return null;
  }
}
