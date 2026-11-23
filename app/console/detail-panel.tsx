import Link from "next/link";
import { ClassChip, shortId } from "@/components/console";
import { sessionDetail, ticketDetail } from "@/lib/console/details";
import { getDb } from "@/lib/db/server";

const hhmmss = (d: Date) => d.toISOString().slice(11, 19);

// Detail panel beside the request table (design.md 4.8): a Ticket tab with the
// ticket's timeline, and a Session tab with login class beside the current class,
// a probable-handover flag and the risk-state timeline.
export async function DetailPanel({
  ticketId,
  sessionId,
  tab,
  tabLink,
  closeLink,
}: {
  ticketId: string | null;
  sessionId: string | null;
  tab: "ticket" | "session";
  tabLink: (tab: "ticket" | "session") => string;
  closeLink: string;
}) {
  const db = getDb();
  const ticket = ticketId ? await ticketDetail(db, ticketId) : null;
  // The Session tab shows the chosen session, or the one that requested the ticket.
  const sid = sessionId ?? ticket?.ticket.requestingSessionId ?? null;
  const session = sid ? await sessionDetail(db, sid) : null;
  const active = tab === "session" || !ticket ? "session" : "ticket";

  const tabClass = (on: boolean) =>
    `px-3 py-2 text-sm font-medium ${on ? "border-b-2 border-primary text-primary" : "text-on-surface-variant"}`;

  return (
    <aside
      aria-label="Details"
      className="h-fit rounded-xl border border-outline-variant bg-white p-4"
    >
      <div className="mb-3 flex items-center border-b border-outline-variant">
        <nav role="tablist" aria-label="Detail views" className="flex">
          {ticket && (
            <Link
              role="tab"
              aria-selected={active === "ticket"}
              href={tabLink("ticket")}
              className={tabClass(active === "ticket")}
            >
              Ticket
            </Link>
          )}
          {session && (
            <Link
              role="tab"
              aria-selected={active === "session"}
              href={tabLink("session")}
              className={tabClass(active === "session")}
            >
              Session
            </Link>
          )}
        </nav>
        <Link
          href={closeLink}
          className="ml-auto text-sm text-primary underline-offset-4 hover:underline"
        >
          Close
        </Link>
      </div>

      {active === "ticket" && ticket && (
        <section role="tabpanel" aria-label="Ticket">
          <h2 className="mb-1 break-all font-mono text-sm">
            {shortId(ticket.ticket.id, 16)} · {ticket.ticket.action}
          </h2>
          <p className="mb-3 text-sm text-on-surface-variant">
            {String((ticket.ticket.payloadPreview as { summary?: unknown }).summary ?? "")} · hash{" "}
            {ticket.ticket.payloadHash.slice(0, 8)}… · state {ticket.ticket.state}
            {ticket.runId && ` · run ${ticket.runId}`}
          </p>
          {ticket.flag && (
            <p className="mb-3 rounded-lg bg-warning-container px-3 py-2 text-sm text-on-warning-container">
              Approved, not redeemed: the agent did not retry before the approval expired (a resume
              failure).
            </p>
          )}
          <ol className="space-y-3 border-l-2 border-outline-variant pl-4">
            {ticket.steps.map((s) => (
              <li key={`${s.label}-${s.at.toISOString()}`}>
                <p className="text-sm font-medium">
                  {s.label} <time dateTime={s.at.toISOString()}>{hhmmss(s.at)}</time>
                </p>
                <p className="text-sm text-on-surface-variant">{s.detail}</p>
              </li>
            ))}
          </ol>
          {ticket.attempts.some((a) => a.reason?.startsWith("ticket:")) && (
            <>
              <h3 className="mb-1 mt-4 text-sm font-medium">Rejected redemption attempts</h3>
              <ul className="text-sm text-on-surface-variant">
                {ticket.attempts
                  .filter((a) => a.reason?.startsWith("ticket:"))
                  .map((a) => (
                    <li key={a.id}>
                      {hhmmss(a.ts)}{" "}
                      {a.reason === "ticket:wrong_session"
                        ? "wrong session (not an agent error)"
                        : a.reason?.slice(7)}
                    </li>
                  ))}
              </ul>
            </>
          )}
        </section>
      )}

      {active === "session" && session && (
        <section role="tabpanel" aria-label="Session">
          <h2 className="mb-2 font-mono text-sm">Session {shortId(session.session.id, 12)}</h2>
          <p className="mb-2 flex flex-wrap items-center gap-2 text-sm">
            Login class <ClassChip value={session.session.loginActorClass} /> → now{" "}
            <ClassChip value={session.currentClass} />
            {session.probableHandover && (
              <span className="rounded-lg bg-error-container px-2 py-0.5 text-xs font-medium text-on-error-container">
                probable handover
              </span>
            )}
          </p>
          <p className="mb-3 text-sm text-on-surface-variant">
            Signed in with {session.session.signinMethod}
            {session.session.approvalOnly && " (approval only)"} · risk {session.session.riskState}
            {session.session.runId && ` · run ${session.session.runId}`}
            {session.session.revokedAt && ` · ended (${session.session.revokeReason})`}
          </p>
          <ol className="space-y-2 border-l-2 border-outline-variant pl-4 text-sm">
            <li>
              <time dateTime={session.session.createdAt.toISOString()}>
                {hhmmss(session.session.createdAt)}
              </time>{" "}
              signed in ({session.session.signinMethod})
            </li>
            {session.events.map((e) => (
              <li key={e.id}>
                <time dateTime={e.ts.toISOString()}>{hhmmss(e.ts)}</time>{" "}
                {e.event === "risk_changed"
                  ? `${e.fromState} → ${e.toState} (${e.trigger.replace(/_/g, " ")})`
                  : `session ended (${e.trigger})`}
              </li>
            ))}
          </ol>
        </section>
      )}

      {!ticket && !session && (
        <p className="text-sm text-on-surface-variant">Nothing found for this selection.</p>
      )}
    </aside>
  );
}
