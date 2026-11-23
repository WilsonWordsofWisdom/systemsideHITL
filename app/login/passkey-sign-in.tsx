"use client";

import { startAuthentication } from "@simplewebauthn/browser";
import { useState } from "react";

declare global {
  interface Window {
    __dgSignals?: () => Record<string, unknown>;
  }
}

// "Sign in with a passkey" (FR6). Works only with JavaScript; the password form
// above does not depend on it. With `ticketId` (on /approve) or `device` (on the
// phone page) it signs in for an approval-only session (W11); the server decides
// where to go next.
export function PasskeySignIn({
  ticketId,
  device = false,
  next,
  label = "Sign in with a passkey",
}: {
  ticketId?: string;
  device?: boolean;
  next?: string;
  label?: string;
}) {
  const approval = Boolean(ticketId) || device;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function signIn() {
    setError(null);
    setBusy(true);
    try {
      const start = await fetch("/api/auth/passkey/options", { method: "POST" });
      if (!start.ok) throw new Error();
      const { options, challengeId } = await start.json();
      const response = await startAuthentication({ optionsJSON: options });
      const finish = await fetch("/api/auth/passkey/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          challengeId,
          response,
          signals: JSON.stringify(window.__dgSignals?.() ?? {}),
          ...(ticketId ? { mode: "approval", ticketId } : {}),
          ...(device ? { mode: "approval", device: true } : {}),
          ...(next ? { next } : {}),
        }),
      });
      if (!finish.ok) throw new Error();
      const { redirect } = await finish.json();
      window.location.assign(redirect);
    } catch {
      setError(
        approval
          ? "Passkey sign-in didn't work. Try again on the device that holds your passkey."
          : "Passkey sign-in didn't work. Try again, or sign in with your password.",
      );
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={signIn}
        disabled={busy}
        className="h-10 w-full rounded-full border border-outline text-sm font-medium text-primary disabled:opacity-60"
      >
        {label}
      </button>
      {error && (
        <p
          role="alert"
          className="mt-3 rounded-xl bg-error-container px-4 py-3 text-sm text-on-error-container"
        >
          {error}
        </p>
      )}
    </div>
  );
}
