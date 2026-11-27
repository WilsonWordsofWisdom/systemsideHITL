"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { btn } from "@/components/journey";

const REFRESH_MS = 5_000;

// Live table (design.md 4.8): re-renders the server page every few seconds so new
// rows appear at the top. The tester can pause it while reading.
export function LiveRefresh() {
  const router = useRouter();
  const [on, setOn] = useState(true);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => router.refresh(), REFRESH_MS);
    return () => clearInterval(t);
  }, [on, router]);
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} />
      Live updates
    </label>
  );
}

// "Reset demo data" with a confirmation dialog: the one dialog in the product,
// admin only (design.md 4.8, control L3).
export function ResetDemoData({ csrf }: { csrf: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  return (
    <>
      <button type="button" className={btn.danger} onClick={() => dialog.current?.showModal()}>
        Reset demo data
      </button>
      <dialog
        ref={dialog}
        aria-labelledby="reset-title"
        className="m-auto max-w-md rounded-xl p-6 backdrop:bg-black/40"
      >
        <h2 id="reset-title" className="mb-2 text-lg font-medium">
          Reset demo data?
        </h2>
        <p className="mb-4 text-sm">
          This deletes every request log entry, ticket, session and application, then restores the
          seed applications. Everyone is signed out. Users, passkeys and run labels are kept.
        </p>
        <form action="/api/console/reset" method="post" className="flex justify-end gap-3">
          <input type="hidden" name="csrf" value={csrf} />
          <input type="hidden" name="confirm" value="reset" />
          <button type="button" className={btn.text} onClick={() => dialog.current?.close()}>
            Cancel
          </button>
          <button type="submit" className={btn.danger}>
            Yes, reset demo data
          </button>
        </form>
      </dialog>
    </>
  );
}

// Issues a one-time passkey enrolment code for an account (gap H1, control W12).
// The code is shown once here; the admin gives it to the person out of band.
export function EnrolmentCode({ csrf }: { csrf: string }) {
  const [email, setEmail] = useState("");
  const [result, setResult] = useState<
    { tone: "error"; text: string } | { tone: "code"; code: string; expiresAt: string } | null
  >(null);
  async function issue(e: React.FormEvent) {
    e.preventDefault();
    setResult(null);
    const res = await fetch("/api/console/enrolment-code", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify({ email }),
    }).catch(() => null);
    const body = res ? await res.json().catch(() => ({})) : {};
    if (!res?.ok) {
      const text =
        body.error === "unknown_account"
          ? "There's no account with that email address."
          : body.error === "invalid_email"
            ? "Enter a valid email address."
            : "The code wasn't issued. Try again.";
      setResult({ tone: "error", text });
      return;
    }
    setResult({ tone: "code", code: body.code, expiresAt: body.expiresAt });
  }
  const time = new Intl.DateTimeFormat("en-GB", { timeStyle: "short" });
  return (
    <details className="mb-4 rounded-xl border border-outline-variant bg-white px-6 py-3">
      <summary className="cursor-pointer text-sm font-medium">Passkey enrolment code</summary>
      <p className="mb-3 mt-2 text-sm text-on-surface-variant">
        A person needs a code to add their first passkey, or to add one without signing in with a
        passkey. It works once, for one account, for 15 minutes. Give it to them yourself, not
        through an AI assistant.
      </p>
      <form onSubmit={issue} className="flex flex-wrap items-end gap-3">
        <div>
          <label
            htmlFor="enrol-email"
            className="mb-1 block text-xs font-medium text-on-surface-variant"
          >
            Account email address
          </label>
          <input
            id="enrol-email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="h-10 w-72 rounded border border-outline bg-white px-3"
          />
        </div>
        <button type="submit" className={btn.outlined}>
          Issue code
        </button>
      </form>
      {result?.tone === "error" && (
        <p
          role="alert"
          className="mt-3 rounded-xl bg-error-container px-4 py-3 text-sm text-on-error-container"
        >
          {result.text}
        </p>
      )}
      {result?.tone === "code" && (
        <p
          role="status"
          className="mt-3 rounded-xl bg-success-container px-4 py-3 text-sm text-on-success-container"
        >
          Enrolment code <strong className="font-mono text-base">{result.code}</strong>, valid until{" "}
          {time.format(new Date(result.expiresAt))}. It won&apos;t be shown again.
        </p>
      )}
    </details>
  );
}
