import { generateAuthenticationOptions } from "@simplewebauthn/server";
import { NextResponse } from "next/server";
import { appConfig } from "@/lib/app";
import { issueChallenge } from "@/lib/auth/webauthn";
import { getDb } from "@/lib/db/server";
import { isSameOrigin } from "@/lib/http";

// Starts passkey sign-in. Credentials are discoverable, so no username is asked
// for and nothing reveals whether an account exists.
export async function POST(request: Request) {
  const { appOrigin, rpId } = appConfig();
  if (!isSameOrigin(request, appOrigin)) {
    return NextResponse.json({ error: "bad_request" }, { status: 403 });
  }
  const options = await generateAuthenticationOptions({ rpID: rpId, userVerification: "required" });
  const challengeId = await issueChallenge(getDb(), {
    purpose: "login",
    challenge: options.challenge,
  });
  return NextResponse.json({ options, challengeId });
}
