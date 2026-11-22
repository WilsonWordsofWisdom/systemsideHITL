import { generateRegistrationOptions } from "@simplewebauthn/server";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { appConfig } from "@/lib/app";
import { requestMeta, requireJsonSession } from "@/lib/auth/request";
import { RP_NAME, enrolmentAllowed, issueChallenge } from "@/lib/auth/webauthn";
import { passkeys } from "@/lib/db/schema";
import { getDb } from "@/lib/db/server";
import { passkeyEnrolmentOpen } from "@/lib/flags";
import { logEvent } from "@/lib/log";

// Starts passkey enrolment for the signed-in user (FR7). Refused, and audited,
// while PASSKEY_ENROLMENT is closed or the sign-in is not fresh (control W7).
export async function POST(request: Request) {
  const auth = await requireJsonSession(request);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { session, user } = auth.current;
  const db = getDb();

  const check = enrolmentAllowed({ open: passkeyEnrolmentOpen(), session });
  if (!check.ok) {
    await logEvent(db, {
      route: "web",
      method: "POST",
      pathOrTool: "passkey_enrol_options",
      userId: user.id,
      sessionId: session.id,
      actorClass: session.loginActorClass,
      outcome: "blocked",
      reason: check.reason,
      ...requestMeta(request),
    });
    return NextResponse.json({ error: check.reason }, { status: 403 });
  }

  const existing = await db
    .select({ id: passkeys.credentialId, transports: passkeys.transports })
    .from(passkeys)
    .where(eq(passkeys.userId, user.id));
  const { rpId } = appConfig();
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rpId,
    userName: user.email,
    userDisplayName: user.name,
    userID: new TextEncoder().encode(user.id),
    attestationType: "none",
    excludeCredentials: existing,
    // Discoverable credential so sign-in needs no username; UV always (control W1).
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
  const challengeId = await issueChallenge(db, {
    purpose: "register",
    challenge: options.challenge,
    userId: user.id,
    sessionId: session.id,
  });
  return NextResponse.json({ options, challengeId });
}
