import Link from "next/link";
import QRCode from "qrcode";
import { notFound } from "next/navigation";
import { CsrfField, Notice, btn } from "@/components/journey";
import { PasskeySignIn } from "@/app/login/passkey-sign-in";
import { appConfig } from "@/lib/app";
import { getApproverSession } from "@/lib/auth/current";
import { getDb } from "@/lib/db/server";
import { previewRows } from "@/lib/hitl/preview";
import { getTicket } from "@/lib/hitl/tickets";
import { ApproveButton } from "./approve-button";

// /approve/[ticketId]: the account holder sees exactly what they are approving and
// approves with a passkey (spec 9.3, design.md 4.6, FR20, FR21).
export default async function ApprovePage({ params }: PageProps<"/approve/[ticketId]">) {
  const { ticketId } = await params;
  const host = new URL(appConfig().appOrigin).host;
  const ticket = await getTicket(getDb(), ticketId);
  if (!ticket) notFound();
  const approver = await getApproverSession();

  const domain = (
    <p className="mb-6 rounded-xl bg-info-container px-6 py-3 text-on-info-container">
      You are approving on <strong>{host}</strong>
    </p>
  );

  if (!approver || approver.user.id !== ticket.userId) {
    return (
      <div className="max-w-xl">
        {domain}
        <h1 className="mb-4 text-[28px] leading-9">
          {approver ? "This request belongs to another account" : "Sign in to review this request"}
        </h1>
        <p className="mb-6">
          {approver
            ? "Sign in with the passkey of the account that made the request to review it."
            : "Requests are approved with the account holder's passkey. Signing in here does not sign anyone else out."}
        </p>
        <PasskeySignIn
          ticketId={ticket.id}
          label={approver ? "Sign in as a different user" : "Sign in with a passkey"}
        />
      </div>
    );
  }

  const ended: Record<string, { tone: "success" | "warn"; title: string; body: string }> = {
    approved: {
      tone: "success",
      title: "Approved",
      body: "The request can now continue. You can close this page.",
    },
    consumed: {
      tone: "success",
      title: "Approved and completed",
      body: "This request has been carried out.",
    },
    expired: {
      tone: "warn",
      title: "This request expired",
      body: "Approvals last 10 minutes. A new request is needed.",
    },
    rejected:
      ticket.rejectReason === "superseded"
        ? {
            tone: "warn",
            title: "A newer request replaced this one",
            body: "Review the newer request instead.",
          }
        : { tone: "warn", title: "You declined this request", body: "Nothing was changed." },
  };
  const state = ended[ticket.state];
  // "Send to my phone instead" (design.md 4.6): the phone page lists this account's
  // pending requests, so the link is the same for every ticket (FR22).
  const deviceLink = new URL(`/device/${ticket.userId}`, appConfig().appOrigin).toString();
  const deviceQr =
    ticket.state === "pending"
      ? await QRCode.toString(deviceLink, { type: "svg", margin: 1, errorCorrectionLevel: "M" })
      : "";

  return (
    <div className="max-w-xl">
      {domain}
      <h1 className="mb-4 text-[28px] leading-9">Approve this request?</h1>
      {state && (
        <Notice tone={state.tone} title={state.title}>
          {state.body}
        </Notice>
      )}
      <dl className="mb-6 grid grid-cols-[180px_1fr] border-t border-outline-variant">
        {previewRows(ticket).map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="border-b border-outline-variant py-3 text-on-surface-variant">{k}</dt>
            <dd className="border-b border-outline-variant py-3">{v}</dd>
          </div>
        ))}
      </dl>
      {ticket.state === "pending" && (
        <>
          <div className="flex flex-wrap items-start gap-3">
            <ApproveButton ticketId={ticket.id} csrf={approver.csrf} className={btn.filled} />
            <form action={`/api/hitl/${ticket.id}/reject`} method="post">
              <CsrfField csrf={approver.csrf} />
              <button type="submit" className={btn.outlined}>
                Decline
              </button>
            </form>
          </div>
          <details className="mt-4">
            <summary className={`${btn.text} cursor-pointer`}>Send to my phone instead</summary>
            <div className="mt-3 flex flex-wrap items-start gap-4 rounded-xl border border-outline-variant p-4">
              <div
                role="img"
                aria-label="QR code for the phone page"
                className="h-32 w-32 shrink-0 [&>svg]:h-full [&>svg]:w-full"
                dangerouslySetInnerHTML={{ __html: deviceQr }}
              />
              <div className="min-w-0 flex-1 text-sm">
                <p className="mb-2">
                  Open this page on your phone and sign in with your passkey. Requests waiting for
                  you appear there.
                </p>
                <p className="break-all">
                  <a href={deviceLink} className="text-primary underline underline-offset-4">
                    {deviceLink}
                  </a>
                </p>
              </div>
            </div>
          </details>
          <p className="mt-4 text-sm text-on-surface-variant">
            You&apos;ll be asked for your fingerprint, face or device PIN. No passkey on this
            account yet?{" "}
            <Link href="/account/passkeys" className="text-primary underline underline-offset-4">
              Set one up
            </Link>
            .
          </p>
        </>
      )}
    </div>
  );
}
