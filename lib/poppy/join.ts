// Poppy browser join (Poppy 1.0 section 6; FR47). The agent's browser loads the
// join page and gets a one-time code (60 seconds, works once) bound to a
// __Host- cookie; the agent authorises the code with its Session (and, to sign the
// browser in, a token with poppy:browser-sign-in); the browser then submits the
// code and gets a website session marked as a Poppy join. That session is a
// declared agent on every request, so the gate applies as for any agent.
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { randomToken, sha256Hex } from "@/lib/auth/crypto";
import { revokeSession } from "@/lib/auth/session";
import { poppyJoinCodes, sessions } from "@/lib/db/schema";
import type { AppDb } from "@/lib/db/types";

export const JOIN_PATH = "/poppy/join";
export const JOIN_COOKIE = "__Host-poppy_join";
export const JOIN_TTL_SECONDS = 60;

export async function startJoin(db: AppDb, now = new Date()) {
  const code = `bc_${randomToken(32)}`;
  const cookie = randomToken(32);
  await db.insert(poppyJoinCodes).values({
    id: sha256Hex(code),
    cookieHash: sha256Hex(cookie),
    createdAt: now,
    expiresAt: new Date(now.getTime() + JOIN_TTL_SECONDS * 1000),
  });
  return { code, cookie };
}

// Step 2: the agent's Session (and account, for a signed-in join) claims the code.
export async function authorizeJoin(
  db: AppDb,
  code: string,
  by: { clientId: string; sid: string; userId: string | null; codeId: string | null },
  now = new Date(),
) {
  const rows = await db
    .update(poppyJoinCodes)
    .set({ authorizedAt: now, ...by })
    .where(
      and(
        eq(poppyJoinCodes.id, sha256Hex(code)),
        isNull(poppyJoinCodes.authorizedAt),
        isNull(poppyJoinCodes.usedAt),
        gt(poppyJoinCodes.expiresAt, now),
      ),
    )
    .returning({ id: poppyJoinCodes.id });
  return rows.length === 1;
}

// Step 3: the browser submits the code with its cookie. The first submission uses
// the code up, whatever the result; null when any check fails.
export async function completeJoin(
  db: AppDb,
  code: string,
  cookie: string | undefined,
  now = new Date(),
) {
  const [row] = await db
    .update(poppyJoinCodes)
    .set({ usedAt: now })
    .where(and(eq(poppyJoinCodes.id, sha256Hex(code)), isNull(poppyJoinCodes.usedAt)))
    .returning();
  if (!row || !cookie || row.cookieHash !== sha256Hex(cookie)) return null;
  if (!row.authorizedAt || row.expiresAt <= now || !row.clientId || !row.sid) return null;
  return row;
}

// Ends the website sessions joined under a sign-in when it is revoked (Poppy 6:
// the join stops acting for the account when the agent is disconnected).
export async function endJoinedSessions(db: AppDb, codeId: string, now = new Date()) {
  const joined = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        eq(sessions.signinMethod, "poppy_join"),
        isNull(sessions.revokedAt),
        sql`${sessions.loginSignals}->'poppy'->>'codeId' = ${codeId}`,
      ),
    );
  for (const s of joined) await revokeSession(db, s.id, "poppy_signed_out", now);
  return joined.length;
}
