"use client";

import { useEffect, useRef, useState } from "react";
import { Notice, btn } from "./journey";

type State = "pending" | "approved" | "rejected" | "expired" | "consumed";

export interface HandoffLiveProps {
  ticketId: string;
  summary: string;
  link: string;
  qrSvg: string;
  expiresAt: string;
  initialState: State;
  initialReason: string | null;
  // Resubmits exactly the approved request with the ticket (FR27).
  resubmit: { action: string; fields: Record<string, string> };
  csrf: string;
  autoresume: boolean;
  redirectLink: boolean;
}

const POLL_MS = 3_000;

function remaining(expiresAt: string, now: number) {
  const s = Math.max(0, Math.floor((Date.parse(expiresAt) - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// The live part of the handoff panel (spec 9.2, design.md 4.5): status over SSE
// with a polling fallback, a countdown, and Continue or auto-resume on approval.
export function HandoffLive(p: HandoffLiveProps) {
  const [state, setState] = useState<State>(p.initialState);
  const [reason, setReason] = useState(p.initialReason);
  const [now, setNow] = useState(() => Date.now());
  const form = useRef<HTMLFormElement>(null);
  const resumed = useRef(false);

  useEffect(() => {
    if (state !== "pending") return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [state]);

  // SSE first; on any stream error, poll instead.
  useEffect(() => {
    if (p.initialState !== "pending") return;
    let es: EventSource | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let done = false;
    const apply = (data: { state: State; reason: string | null }) => {
      setState(data.state);
      setReason(data.reason);
      if (data.state !== "pending") stop();
    };
    const stop = () => {
      done = true;
      es?.close();
      if (poll) clearInterval(poll);
    };
    const startPolling = () => {
      if (poll || done) return;
      poll = setInterval(async () => {
        const res = await fetch(`/api/hitl/${p.ticketId}`, { cache: "no-store" }).catch(() => null);
        if (res?.ok) apply(await res.json());
      }, POLL_MS);
    };
    const open = () => {
      if (done) return;
      if (typeof EventSource === "undefined") return startPolling();
      es = new EventSource(`/api/hitl/${p.ticketId}/events`);
      es.addEventListener("state", (e) => apply(JSON.parse((e as MessageEvent).data)));
      es.addEventListener("reconnect", () => {
        es?.close();
        open();
      });
      es.onerror = () => {
        es?.close();
        startPolling();
      };
    };
    open();
    return stop;
  }, [p.ticketId, p.initialState]);

  // Variant B: resubmit without a click (HITL_AUTORESUME=on).
  useEffect(() => {
    if (state === "approved" && p.autoresume && !resumed.current) {
      resumed.current = true;
      form.current?.requestSubmit();
    }
  }, [state, p.autoresume]);

  if (state === "pending") {
    return (
      <section
        role="alert"
        aria-live="assertive"
        className="mb-6 rounded-xl border border-outline-variant bg-white p-6"
      >
        <h2 className="mb-2 text-[22px] leading-7">Human approval needed</h2>
        <p className="mb-4">
          {p.summary} needs approval from the account holder with their passkey.
        </p>
        <div className="mb-4 flex flex-wrap items-start gap-6">
          <div
            role="img"
            aria-label="QR code for the approval link"
            className="h-40 w-40 shrink-0 [&>svg]:h-full [&>svg]:w-full"
            dangerouslySetInnerHTML={{ __html: p.qrSvg }}
          />
          <div className="min-w-0 flex-1">
            <p className="mb-1 text-sm text-on-surface-variant">Approval link</p>
            <p className="mb-4 break-all">
              <a href={p.link} className="text-primary underline underline-offset-4">
                {p.link}
              </a>
            </p>
            {p.redirectLink && (
              <a href={p.link} className={btn.outlined}>
                Go to the approval page
              </a>
            )}
          </div>
        </div>
        <p className="text-sm" aria-live="polite">
          Status: waiting for approval.{" "}
          {p.autoresume
            ? "This page continues automatically once the request is approved."
            : "This page updates automatically once the request is approved."}
        </p>
        <p className="text-sm text-on-surface-variant">
          Expires in{" "}
          <time dateTime={p.expiresAt} suppressHydrationWarning>
            {remaining(p.expiresAt, now)}
          </time>
        </p>
      </section>
    );
  }

  if (state === "approved") {
    return (
      <div className="mb-6">
        <Notice tone="success" title="Approved: continue">
          {p.autoresume
            ? "Continuing with the approved request."
            : "The account holder approved this request."}
        </Notice>
        <form ref={form} action={p.resubmit.action} method="post">
          <input type="hidden" name="csrf" value={p.csrf} />
          <input type="hidden" name="hitl_ticket" value={p.ticketId} />
          {Object.entries(p.resubmit.fields).map(([k, v]) => (
            <input key={k} type="hidden" name={k} value={v} />
          ))}
          <button type="submit" className={btn.filled}>
            Continue
          </button>
        </form>
      </div>
    );
  }

  if (state === "consumed") {
    return <Notice tone="success" title="This approval has been used" />;
  }

  const ended =
    state === "expired"
      ? "This request expired. Approvals last 10 minutes."
      : reason === "superseded"
        ? "A newer request replaced this one."
        : "The account holder declined this request.";
  return (
    <div className="mb-6">
      <Notice tone="warn" title="This approval request has ended">
        {ended} Submitting again creates a new request.
      </Notice>
      <a href="?" className={btn.outlined}>
        Submit again
      </a>
    </div>
  );
}
