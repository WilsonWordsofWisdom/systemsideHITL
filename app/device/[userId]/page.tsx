import type { Metadata } from "next";
import { ApproveButton } from "@/app/approve/[ticketId]/approve-button";
import { PasskeySignIn } from "@/app/login/passkey-sign-in";
import { CsrfField, btn } from "@/components/journey";
import { appConfig } from "@/lib/app";
import { getApproverSession } from "@/lib/auth/current";
import { getDb } from "@/lib/db/server";
import { pendingTickets, recentDecisions } from "@/lib/hitl/device";
import { ACTOR_LABEL, previewRows } from "@/lib/hitl/preview";
import type { Ticket } from "@/lib/hitl/tickets";
import { DeviceLive } from "./device-live";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Approvals - DemoGov Permits" };

const time = (d: Date) => `${d.toISOString().slice(11, 16)} UTC`;

function summaryOf(t: Ticket) {
  return String((t.payloadPreview as { summary?: unknown }).summary ?? t.action);
}

// The detail rows other than the ones the card shows itself.
const detailRows = (t: Ticket) =>
  previewRows(t).filter(([k]) => k !== "Request" && k !== "Requested by" && k !== "Expires");

function PendingCard({ t, csrf }: { t: Ticket; csrf: string }) {
  const actor = (t.requestedByActor as { class?: string }).class ?? "unknown";
  return (
    <li className="rounded-xl border border-outline-variant bg-white p-4">
      <p className="mb-1 text-xs font-medium text-on-surface-variant">New · {time(t.createdAt)}</p>
      <h2 className="mb-2 text-lg font-medium">{summaryOf(t)}</h2>
      <dl className="mb-3 text-sm">
        {detailRows(t).map(([k, v]) => (
          <div key={k} className="flex gap-2">
            <dt className="text-on-surface-variant">{k}:</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <p className="mb-1 text-sm">
        Requested by{" "}
        <span className="rounded-lg bg-info-container px-2 py-0.5 text-on-info-container">
          {ACTOR_LABEL[actor] ?? actor}
        </span>
      </p>
      <p className="mb-4 text-sm text-on-surface-variant">Expires {time(t.expiresAt)}</p>
      <div className="grid gap-2">
        <ApproveButton ticketId={t.id} csrf={csrf} className={`${btn.filled} w-full`} />
        <form action={`/api/hitl/${t.id}/reject`} method="post">
          <CsrfField csrf={csrf} />
          <input type="hidden" name="return" value="device" />
          <button type="submit" className={`${btn.outlined} w-full`}>
            Decline
          </button>
        </form>
      </div>
    </li>
  );
}

function DecidedCard({ t }: { t: Ticket }) {
  const label =
    t.state === "rejected"
      ? t.rejectReason === "superseded"
        ? "Replaced by a newer request"
        : "Declined"
      : "Approved";
  return (
    <li className="rounded-xl border border-outline-variant px-4 py-3 text-sm">
      <span className="font-medium">{label}</span> · {summaryOf(t)}
      {t.decidedAt && <span className="text-on-surface-variant"> · {time(t.decidedAt)}</span>}
    </li>
  );
}

// /device/[userId]: the simulated phone (FR22, design.md 4.7, controls W6, W11).
// Every pending request of the signed-in account holder arrives here live; each
// approval needs its own passkey assertion bound to the ticket. Signing in here
// starts an approval-only session, so the agent's session keeps running (T9).
export default async function DevicePage({ params }: PageProps<"/device/[userId]">) {
  const { userId } = await params;
  const host = new URL(appConfig().appOrigin).host;
  const approver = await getApproverSession();

  const header = (
    <header className="mb-4">
      <p className="text-lg font-medium">DG Approvals</p>
      <p className="text-sm text-on-surface-variant">On {host}</p>
    </header>
  );

  // Signed out, or another account's page: nothing about any request is shown.
  if (!approver || approver.user.id !== userId) {
    return (
      <div className="mx-auto max-w-sm">
        {header}
        <h1 className="mb-4 text-[24px] leading-8">
          {approver ? "This page belongs to another account" : "Sign in to see requests"}
        </h1>
        <p className="mb-6">
          Requests are approved with the account holder&apos;s passkey. Signing in here does not
          sign anyone else out.
        </p>
        <PasskeySignIn
          device
          label={approver ? "Sign in as a different user" : "Sign in with a passkey"}
        />
      </div>
    );
  }

  const db = getDb();
  const [pending, decided] = await Promise.all([
    pendingTickets(db, userId),
    recentDecisions(db, userId),
  ]);

  return (
    <div className="mx-auto max-w-sm">
      {header}
      <h1 className="mb-4 text-[24px] leading-8">
        {pending.length ? "Pending approval" : "No requests waiting"}
      </h1>
      <DeviceLive initial={pending.map((t) => t.id)} />
      {pending.length ? (
        <ul className="mb-6 grid gap-4" aria-label="Pending requests">
          {pending.map((t) => (
            <PendingCard key={t.id} t={t} csrf={approver.csrf} />
          ))}
        </ul>
      ) : (
        <p className="mb-6">New requests appear here automatically.</p>
      )}
      {decided.length > 0 && (
        <section aria-labelledby="recent">
          <h2 id="recent" className="mb-2 text-sm font-medium text-on-surface-variant">
            Recent decisions
          </h2>
          <ul className="grid gap-2">
            {decided.map((t) => (
              <DecidedCard key={t.id} t={t} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
