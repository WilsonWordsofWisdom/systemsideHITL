// Poppy Session JWTs (Poppy 1.0 sections 5.2, 5.3; FR46; control PP5). Every check
// fails closed with invalid_session (400, never 401, so OAuth clients keep their
// tokens); an ended Session answers session_ended. A verified Session is tier A
// evidence that a Poppy agent is acting; it never grants account access itself.
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  calculateJwkThumbprint,
  createLocalJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  importJWK,
  jwtVerify,
  type JWK,
} from "jose";
import { poppyLinks, poppySessions } from "@/lib/db/schema";
import type { AppDb } from "@/lib/db/types";
import { agentMetadata as sharedMetadata, type createAgentMetadata } from "./agent-metadata";
import { AGENT_ALGS, firstUse } from "./jwt";

const ID = /^[A-Za-z0-9_-]{1,256}$/;
const IAT_PAST_SECONDS = 90; // about a minute, plus clock skew
const IAT_FUTURE_SECONDS = 30;
const MAX_DELEGATION_SECONDS = 24 * 60 * 60;

export interface PoppySession {
  clientId: string;
  agentName: string;
  sid: string;
  sub: string;
  agentId: string | null;
}

export type SessionCheck =
  | { ok: true; session: PoppySession }
  | { ok: false; error: "invalid_session" | "session_ended"; description: string };

const invalid = (description: string): SessionCheck => ({
  ok: false,
  error: "invalid_session",
  description,
});

export function sessionError(check: Extract<SessionCheck, { ok: false }>) {
  return Response.json(
    { error: check.error, error_description: check.description },
    { status: 400, headers: { "Cache-Control": "no-store" } },
  );
}

export async function verifyPoppySession(
  db: AppDb,
  request: Request,
  opts: {
    // The Company identifier: our issuer (the app origin).
    origin: string;
    // The access token on the same request, if any, and what it was issued for.
    token?: { value: string; clientId: string; userId: string } | null;
    now?: Date;
    metadata?: ReturnType<typeof createAgentMetadata>;
  },
): Promise<SessionCheck | null> {
  const header = request.headers.get("poppy-session");
  if (!header) return null;
  const now = opts.now ?? new Date();
  const metadata = opts.metadata ?? sharedMetadata;
  if (header.length > 16_384) return invalid("The Session header is too long.");

  try {
    // 1. Who claims to be speaking, and their keys.
    const sessionHeader = decodeProtectedHeader(header);
    if (sessionHeader.typ !== "poppy-session+jwt" || sessionHeader.alg !== "ES256") {
      return invalid("Session JWT type or algorithm.");
    }
    const dlg = (sessionHeader as { poppy_dlg?: unknown }).poppy_dlg;
    if (typeof dlg !== "string" || typeof sessionHeader.kid !== "string") {
      return invalid("Session JWT without a delegation.");
    }
    const claimed = decodeJwt(header);
    if (typeof claimed.iss !== "string") return invalid("Session JWT without iss.");
    const client = await metadata.client(claimed.iss);
    if (!client) return invalid("The agent's client metadata could not be verified.");

    // 2. The delegation: signed by a key in the agent's jwks_uri, at most 24 hours.
    const dlgHeader = decodeProtectedHeader(dlg);
    const keys = await metadata.keys(client.jwksUri, dlgHeader.kid);
    const { payload: d } = await jwtVerify(dlg, createLocalJWKSet({ keys }), {
      algorithms: AGENT_ALGS,
      typ: "poppy-delegation+jwt",
      issuer: client.clientId,
      currentDate: now,
      requiredClaims: ["iat", "exp", "jti"],
    });
    if (d.exp! - d.iat! > MAX_DELEGATION_SECONDS) return invalid("Delegation lasts too long.");
    const cnf = (d.cnf as { jwk?: JWK } | undefined)?.jwk;
    if (!cnf || cnf.kty !== "EC" || cnf.crv !== "P-256" || "d" in cnf) {
      return invalid("Delegation without a public P-256 key.");
    }
    if ((await calculateJwkThumbprint(cnf)) !== sessionHeader.kid) {
      return invalid("Session JWT kid is not the delegated key's thumbprint.");
    }

    // 3. The Session JWT itself, signed by the delegated key.
    const { payload: s } = await jwtVerify(header, await importJWK(cnf, "ES256"), {
      algorithms: ["ES256"],
      typ: "poppy-session+jwt",
      issuer: client.clientId,
      currentDate: now,
    });
    if (s.aud !== opts.origin) return invalid("Session JWT aud.");
    const sid = s.sid;
    const sub = s.sub;
    const agentId = s.agent_id;
    if (typeof sid !== "string" || !ID.test(sid)) return invalid("Session JWT sid.");
    if (typeof sub !== "string" || sub.length < 1 || sub.length > 256) {
      return invalid("Session JWT sub.");
    }
    if (agentId !== undefined && (typeof agentId !== "string" || agentId.length > 256)) {
      return invalid("Session JWT agent_id.");
    }
    // htm and htu name this request; htu from the configured origin, not Host.
    const url = new URL(request.url);
    if (s.htm !== request.method || s.htu !== `${opts.origin}${url.pathname}`) {
      return invalid("Session JWT htm or htu.");
    }
    const nowSec = Math.floor(now.getTime() / 1000);
    if (
      typeof s.iat !== "number" ||
      s.iat < nowSec - IAT_PAST_SECONDS ||
      s.iat > nowSec + IAT_FUTURE_SECONDS
    ) {
      return invalid("Session JWT iat is outside the acceptance window.");
    }
    if (typeof s.jti !== "string" || !s.jti) return invalid("Session JWT jti.");
    const until = new Date((nowSec + IAT_PAST_SECONDS + IAT_FUTURE_SECONDS) * 1000);
    if (!(await firstUse(db, `session:${client.clientId}:${s.jti}`, until, now))) {
      return invalid("Session JWT replayed.");
    }

    // 4. The access token on the same request belongs to this agent.
    if (opts.token) {
      const ath = createHash("sha256").update(opts.token.value).digest("base64url");
      if (s.ath !== ath) return invalid("Session JWT ath does not match the access token.");
      if (opts.token.clientId !== client.clientId) {
        return invalid("The access token was issued to another client.");
      }
    } else if (s.ath !== undefined) {
      return invalid("Session JWT ath without an access token.");
    }

    // 5. The Session keeps the user ID and agent ID it started with.
    const [known] = await db
      .select()
      .from(poppySessions)
      .where(and(eq(poppySessions.clientId, client.clientId), eq(poppySessions.sid, sid)))
      .limit(1);
    if (known?.endedAt) return { ok: false, error: "session_ended", description: "Session ended." };
    if (known && (known.sub !== sub || (known.agentId ?? null) !== (agentId ?? null))) {
      return invalid("The Session started with another user ID or agent ID.");
    }
    if (known) {
      await db
        .update(poppySessions)
        .set({ lastSeenAt: now })
        .where(and(eq(poppySessions.clientId, client.clientId), eq(poppySessions.sid, sid)));
    } else {
      await db
        .insert(poppySessions)
        .values({
          clientId: client.clientId,
          sid,
          sub,
          agentId: agentId ?? null,
          createdAt: now,
          lastSeenAt: now,
        })
        .onConflictDoNothing();
    }

    // 6. The agent's user ID is linked to one of our accounts the first time it
    // arrives with a token; a Session can't switch accounts later.
    if (opts.token) {
      const [link] = await db
        .select()
        .from(poppyLinks)
        .where(and(eq(poppyLinks.clientId, client.clientId), eq(poppyLinks.sub, sub)))
        .limit(1);
      if (link && link.userId !== opts.token.userId) {
        return {
          ok: false,
          error: "session_ended",
          description: "This user ID belongs to another account.",
        };
      }
      if (!link) {
        await db
          .insert(poppyLinks)
          .values({ clientId: client.clientId, sub, userId: opts.token.userId, createdAt: now })
          .onConflictDoNothing();
      }
    }

    return {
      ok: true,
      session: {
        clientId: client.clientId,
        agentName: client.name,
        sid,
        sub,
        agentId: (agentId as string) ?? null,
      },
    };
  } catch {
    return invalid("The Session JWT or its delegation could not be verified.");
  }
}
