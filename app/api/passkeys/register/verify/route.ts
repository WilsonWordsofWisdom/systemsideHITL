import { verifyRegistrationResponse, type RegistrationResponseJSON } from "@simplewebauthn/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { appConfig } from "@/lib/app";
import { requestMeta, requireJsonSession } from "@/lib/auth/request";
import { checkEnrolment, consumeEnrolmentCode } from "@/lib/auth/enrolment-codes";
import { consumeChallenge, enrolmentAllowed, toBase64Url } from "@/lib/auth/webauthn";
import { passkeys } from "@/lib/db/schema";
import { getDb } from "@/lib/db/server";
import { passkeyEnrolmentOpen } from "@/lib/flags";
import { logEvent } from "@/lib/log";

const Body = z.object({ challengeId: z.string().min(1).max(100), response: z.unknown() });

// Completes passkey enrolment: verifies the attestation with user verification
// required, stores the credential, and audits the result (controls W7, W12).
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

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });

  const challenge = await consumeChallenge(db, parsed.data.challengeId, "register");
  if (!challenge || challenge.userId !== user.id || challenge.sessionId !== session.id) {
    await audit("blocked", "bad_challenge");
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  // The rule is checked again at completion (controls W7, W12). A challenge issued
  // with an enrolment code carries the code's ID, and the code is used up together
  // with storing the passkey; otherwise a passkey sign-in is still required.
  const codeId = challenge.nonce;
  const check = codeId
    ? enrolmentAllowed({
        open: passkeyEnrolmentOpen(),
        session,
        hasPasskeys: false,
        validCode: true,
      })
    : await checkEnrolment(db, {
        open: passkeyEnrolmentOpen(),
        session,
        userId: user.id,
        code: null,
      });
  if (!check.ok) {
    await audit("blocked", check.reason);
    return NextResponse.json({ error: check.reason }, { status: 403 });
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
  const stored = await db.transaction(async (tx) => {
    if (codeId && !(await consumeEnrolmentCode(tx, codeId, user.id))) return false;
    await tx.insert(passkeys).values({
      userId: user.id,
      credentialId: credential.id,
      publicKey: toBase64Url(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports ?? [],
      aaguid,
      attestationFormat: fmt,
    });
    return true;
  });
  if (!stored) {
    await audit("blocked", "code_invalid");
    return NextResponse.json({ error: "code_invalid" }, { status: 400 });
  }
  const via = codeId ? "code" : "passkey";
  await audit("executed", "passkey_enrolled", { aaguid, attestationFormat: fmt, via });
  return NextResponse.json({ ok: true });
}
