"use client";

import { startAuthentication } from "@simplewebauthn/browser";
import { useState } from "react";

// "Approve with passkey" (spec 9.3). The browser asks for fingerprint, face or
// device PIN; the server checks user verification before approving (FR20).
export function ApproveButton({
  ticketId,
  csrf,
  className,
}: {
  ticketId: string;
  csrf: string;
  className: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function approve() {
    setError(null);
    setBusy(true);
    try {
      const headers = { "content-type": "application/json", "x-csrf-token": csrf };
      const base = `/api/hitl/${encodeURIComponent(ticketId)}`;
      const start = await fetch(`${base}/webauthn/options`, { method: "POST", headers });
      if (!start.ok) throw new Error();
      const { options, challengeId } = await start.json();
      const response = await startAuthentication({ optionsJSON: options });
      const finish = await fetch(`${base}/approve`, {
        method: "POST",
        headers,
        body: JSON.stringify({ challengeId, response }),
      });
      if (!finish.ok) throw new Error();
      window.location.reload();
    } catch {
      setError("The passkey check didn't complete. The request is still waiting for approval.");
      setBusy(false);
    }
  }

  return (
    <div>
      <button type="button" onClick={approve} disabled={busy} className={className}>
        Approve with passkey
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
