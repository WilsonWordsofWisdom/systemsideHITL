import { generateAuthenticationOptions } from "@simplewebauthn/server";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { appConfig } from "@/lib/app";
import { passkeys } from "@/lib/db/schema";
import { approvalRefusal, issueApprovalChallenge } from "@/lib/hitl/approval";
import { approveContext } from "@/lib/hitl/approve-request";

// WebAuthn options for approving one ticket. The challenge is bound to the ticket
// and its payload hash (W2); user verification is required (W1).
export async function POST(
  request: Request,
  ctx: RouteContext<"/api/hitl/[ticketId]/webauthn/options">,
) {
  const { ticketId } = await ctx.params;
  const checked = await approveContext(request, ticketId);
  if (!checked.ok) return checked.response;
  const { db, approver, ticket, now, record } = checked.ctx;

  if (approvalRefusal(ticket, approver.user.id, now)) {
    await record("blocked", `state:${ticket.state}`);
    return NextResponse.json({ error: "not_pending", state: ticket.state }, { status: 409 });
  }
  const creds = await db
    .select({ id: passkeys.credentialId, transports: passkeys.transports })
    .from(passkeys)
    .where(eq(passkeys.userId, approver.user.id));
  if (creds.length === 0) {
    await record("blocked", "no_passkey");
    return NextResponse.json({ error: "no_passkey" }, { status: 409 });
  }

  const { challengeId, bytes } = await issueApprovalChallenge(
    db,
    ticket,
    { userId: approver.user.id, sessionId: approver.session.id },
    now,
  );
  const options = await generateAuthenticationOptions({
    rpID: appConfig().rpId,
    challenge: bytes,
    userVerification: "required",
    allowCredentials: creds.map((c) => ({
      id: c.id,
      transports: c.transports as AuthenticatorTransport[],
    })),
  });
  return NextResponse.json({ options, challengeId });
}
