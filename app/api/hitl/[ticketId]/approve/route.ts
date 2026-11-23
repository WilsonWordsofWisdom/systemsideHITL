import {
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
} from "@simplewebauthn/server";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { appConfig } from "@/lib/app";
import { fromBase64Url } from "@/lib/auth/webauthn";
import { passkeys } from "@/lib/db/schema";
import { approvalRefusal, checkApprovalChallenge } from "@/lib/hitl/approval";
import { approveContext } from "@/lib/hitl/approve-request";
import { approveTicket } from "@/lib/hitl/tickets";

const Body = z.object({
  challengeId: z.string().min(1).max(100),
  response: z.object({ id: z.string().min(1).max(1024) }).passthrough(),
});

// Approves a ticket with a passkey assertion (spec 9.3, FR20). Checks: the
// approver is the ticket's user (W3), the challenge was issued for this ticket and
// payload (W2), the credential belongs to the user, the origin and RP ID match
// APP_ORIGIN (W4), and user verification happened (W1). Only then pending -> approved.
export async function POST(request: Request, ctx: RouteContext<"/api/hitl/[ticketId]/approve">) {
  const { ticketId } = await ctx.params;
  const checked = await approveContext(request, ticketId);
  if (!checked.ok) return checked.response;
  const { db, approver, ticket, now, record } = checked.ctx;
  const refuse = async (status: number, reason: string) => {
    await record("blocked", reason);
    return NextResponse.json({ error: "not_approved", reason }, { status });
  };

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return refuse(400, "invalid");
  if (approvalRefusal(ticket, approver.user.id, now)) {
    return refuse(409, ticket.state === "pending" ? "expired" : ticket.state);
  }

  const challenge = await checkApprovalChallenge(
    db,
    parsed.data.challengeId,
    ticket,
    { userId: approver.user.id, sessionId: approver.session.id },
    now,
  );
  if (!challenge.ok) return refuse(400, challenge.reason);

  const [stored] = await db
    .select()
    .from(passkeys)
    .where(
      and(eq(passkeys.credentialId, parsed.data.response.id), eq(passkeys.userId, ticket.userId)),
    )
    .limit(1);
  if (!stored) return refuse(400, "unknown_credential");

  const { appOrigin, rpId } = appConfig();
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: parsed.data.response as unknown as AuthenticationResponseJSON,
      expectedChallenge: challenge.expectedChallenge,
      expectedOrigin: appOrigin,
      expectedRPID: rpId,
      requireUserVerification: true,
      credential: {
        id: stored.credentialId,
        publicKey: fromBase64Url(stored.publicKey),
        counter: stored.counter,
        transports: stored.transports as AuthenticatorTransport[],
      },
    });
  } catch {
    return refuse(400, "verification_failed");
  }
  if (!verification.verified || !verification.authenticationInfo.userVerified) {
    return refuse(400, "verification_failed");
  }
  await db
    .update(passkeys)
    .set({ counter: verification.authenticationInfo.newCounter })
    .where(eq(passkeys.id, stored.id));

  const approved = await approveTicket(
    db,
    ticket.id,
    {
      method: "passkey",
      meta: {
        credentialId: stored.credentialId,
        approverSession: approver.kind,
        userVerified: true,
      },
    },
    now,
  );
  // The ticket expired or changed state between the check and the update.
  if (!approved) return refuse(409, "not_pending");
  await record("executed", "approved", { credentialId: stored.credentialId });
  return NextResponse.json({ ok: true, state: approved.state });
}
