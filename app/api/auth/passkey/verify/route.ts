import {
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
} from "@simplewebauthn/server";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { appConfig } from "@/lib/app";
import { getSessionSecret, sha256Hex } from "@/lib/auth/crypto";
import { SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth/current";
import { createSession, revokeOtherSessions, revokeSession } from "@/lib/auth/session";
import { consumeChallenge, fromBase64Url } from "@/lib/auth/webauthn";
import { passkeys } from "@/lib/db/schema";
import { getDb } from "@/lib/db/server";
import { clientIp, ipHash, isSameOrigin } from "@/lib/http";
import { logEvent } from "@/lib/log";
import { classifyActor, getClassifierConfig, loginClassification } from "@/lib/hitl/classifier";
import { clientContextHash, loginClassifierInput } from "@/lib/hitl/inputs";
import { headerFacts, parseSignals } from "@/lib/signals";

const Body = z.object({
  challengeId: z.string().min(1).max(100),
  response: z.object({ id: z.string().min(1).max(1024) }).passthrough(),
  signals: z.string().max(4000).optional(),
});

// Passkey sign-in with user verification required (FR6). A successful passkey
// sign-in ends the user's other sessions and starts a clean one (control S9).
export async function POST(request: Request) {
  const { appOrigin, rpId } = appConfig();
  if (!isSameOrigin(request, appOrigin)) {
    return NextResponse.json({ error: "bad_request" }, { status: 403 });
  }
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });

  const db = getDb();
  const now = new Date();
  const secret = getSessionSecret();
  const ip = ipHash(clientIp(request), secret);
  const userAgent = request.headers.get("user-agent")?.slice(0, 300) ?? "";
  const failed = async (reason: string, userId: string | null = null) => {
    await logEvent(db, {
      route: "web",
      method: "POST",
      pathOrTool: "passkey_signin",
      userId,
      outcome: "blocked",
      reason,
      userAgent,
      ipHash: ip,
    });
    return NextResponse.json({ error: "invalid" }, { status: 401 });
  };

  const challenge = await consumeChallenge(db, parsed.data.challengeId, "login", now);
  if (!challenge) return failed("bad_challenge");

  const [stored] = await db
    .select()
    .from(passkeys)
    .where(eq(passkeys.credentialId, parsed.data.response.id))
    .limit(1);
  if (!stored) return failed("unknown_credential");

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: parsed.data.response as unknown as AuthenticationResponseJSON,
      expectedChallenge: challenge.challenge,
      expectedOrigin: appOrigin,
      expectedRPID: rpId,
      requireUserVerification: true,
      credential: {
        id: stored.credentialId,
        publicKey: fromBase64Url(stored.publicKey),
        counter: stored.counter,
        transports: stored.transports,
      },
    });
  } catch {
    return failed("verification_failed", stored.userId);
  }
  if (!verification.verified || !verification.authenticationInfo.userVerified) {
    return failed("verification_failed", stored.userId);
  }
  await db
    .update(passkeys)
    .set({ counter: verification.authenticationInfo.newCounter })
    .where(eq(passkeys.id, stored.id));

  const previous = request.headers
    .get("cookie")
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  if (previous) await revokeSession(db, sha256Hex(previous), "rotated", now);

  const client = parseSignals(parsed.data.signals);
  // Passkey with UV is human-leaning only when the score is low (architecture 4.7 rule 4).
  const actor = classifyActor(
    loginClassifierInput(request, {
      signinMethod: "passkey",
      selfDeclared: false,
      snapshot: client,
    }),
    getClassifierConfig(),
  );
  const { token, session } = await createSession(
    db,
    {
      userId: stored.userId,
      signinMethod: "passkey",
      loginActorClass: actor.class,
      loginSignals: {
        client,
        headers: headerFacts(request),
        userAgent,
        classification: loginClassification(actor),
      },
      clientCtxHash: clientContextHash(request, secret),
    },
    now,
  );
  await revokeOtherSessions(db, stored.userId, session.id, "passkey_reset", now);

  const response = NextResponse.json({ ok: true, redirect: "/applications" });
  response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(appOrigin));
  return response;
}
