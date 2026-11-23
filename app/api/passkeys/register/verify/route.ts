import { verifyRegistrationResponse, type RegistrationResponseJSON } from "@simplewebauthn/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { appConfig } from "@/lib/app";
import { requestMeta, requireJsonSession } from "@/lib/auth/request";
import { consumeChallenge, enrolmentAllowed, toBase64Url } from "@/lib/auth/webauthn";
import { passkeys } from "@/lib/db/schema";
import { getDb } from "@/lib/db/server";
import { passkeyEnrolmentOpen } from "@/lib/flags";
import { logEvent } from "@/lib/log";

const Body = z.object({ challengeId: z.string().min(1).max(100), response: z.unknown() });

// Completes passkey enrolment: verifies the attestation with user verification
// required, stores the credential, and audits the result (control W7).
export async function POST(request: Request) {
  const auth = await requireJsonSession(request);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { session, user } = auth.current;
  const db = getDb();
  const meta = requestMeta(request);
  const audit = (outcome: "executed" | "blocked", reason: string, extra = {}) =>
    logEvent(db, {
      route: "web",
      method: "POST",
      pathOrTool: "passkey_enrol",
      userId: user.id,
      sessionId: session.id,
      actorClass: session.loginActorClass,
      actorSignals: extra,
      outcome,
      reason,
      ...meta,
    });

  const check = enrolmentAllowed({ open: passkeyEnrolmentOpen(), session });
  if (!check.ok) {
    await audit("blocked", check.reason);
    return NextResponse.json({ error: check.reason }, { status: 403 });
  }
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });

  const challenge = await consumeChallenge(db, parsed.data.challengeId, "register");
  if (!challenge || challenge.userId !== user.id || challenge.sessionId !== session.id) {
    await audit("blocked", "bad_challenge");
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const { appOrigin, rpId } = appConfig();
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: parsed.data.response as RegistrationResponseJSON,
      expectedChallenge: challenge.challenge,
      expectedOrigin: appOrigin,
      expectedRPID: rpId,
      requireUserVerification: true,
    });
  } catch {
    await audit("blocked", "verification_failed");
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  if (!verification.verified) {
    await audit("blocked", "verification_failed");
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const { credential, aaguid, fmt } = verification.registrationInfo;
  await db.insert(passkeys).values({
    userId: user.id,
    credentialId: credential.id,
    publicKey: toBase64Url(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports ?? [],
    aaguid,
    attestationFormat: fmt,
  });
  await audit("executed", "passkey_enrolled", { aaguid, attestationFormat: fmt });
  return NextResponse.json({ ok: true });
}
