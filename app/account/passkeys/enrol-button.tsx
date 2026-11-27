"use client";

import { startRegistration } from "@simplewebauthn/browser";
import { useRouter } from "next/navigation";
import { useState } from "react";

const REASONS: Record<string, string> = {
  enrolment_closed: "Adding passkeys is turned off.",
  signin_not_fresh: "For your security, sign in again before adding a passkey.",
  code_required: "Enter the enrolment code you were given.",
  passkey_signin_required:
    "Sign in with one of your passkeys to add another, or enter an enrolment code.",
  code_invalid: "That enrolment code isn't valid. Check it, or ask for a new one.",
  code_locked: "Too many wrong codes. Wait 10 minutes, then try again.",
};

export function EnrolButton({
  csrf,
  disabled,
  needsCode,
}: {
  csrf: string;
  disabled: boolean;
  needsCode: boolean;
}) {
  const router = useRouter();
  const [message, setMessage] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");

  async function enrol() {
    setMessage(null);
    setBusy(true);
    const post = (url: string, body?: unknown) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrf },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    try {
      const start = await post("/api/passkeys/register/options", needsCode ? { code } : {});
      const startBody = await start.json();
      if (!start.ok) {
        setMessage({ tone: "error", text: REASONS[startBody.error] ?? "Something went wrong." });
        return;
      }
      const response = await startRegistration({ optionsJSON: startBody.options });
      const finish = await post("/api/passkeys/register/verify", {
        challengeId: startBody.challengeId,
        response,
      });
      if (!finish.ok) {
        const finishBody = await finish.json().catch(() => ({}));
        setMessage({
          tone: "error",
          text: REASONS[finishBody.error] ?? "The passkey wasn't added. Try again.",
        });
        return;
      }
      setMessage({ tone: "success", text: "Passkey added." });
      router.refresh();
    } catch {
      setMessage({ tone: "error", text: "The passkey wasn't added. Try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-6">
      {needsCode && (
        <div className="mb-4 max-w-sm">
          <label htmlFor="enrolment-code" className="mb-1 block text-sm font-medium">
            Enrolment code
          </label>
          <p id="enrolment-code-help" className="mb-2 text-sm text-on-surface-variant">
            You need a one-time code from the service administrator to add a passkey without signing
            in with one.
          </p>
          <input
            id="enrolment-code"
            aria-describedby="enrolment-code-help"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            disabled={disabled}
            className="h-14 w-full rounded border border-outline bg-white px-4 font-mono uppercase"
          />
        </div>
      )}
      <button
        type="button"
        onClick={enrol}
        disabled={disabled || busy}
        className="h-10 rounded-full bg-primary px-6 text-sm font-medium text-on-primary disabled:bg-[#e1e4e4] disabled:text-[#5f6769]"
      >
        Add a passkey
      </button>
      {message && (
        <p
          role={message.tone === "error" ? "alert" : "status"}
          className={`mt-3 rounded-xl px-4 py-3 text-sm ${
            message.tone === "error"
              ? "bg-error-container text-on-error-container"
              : "bg-success-container text-on-success-container"
          }`}
        >
          {message.text}
        </p>
      )}
    </div>
  );
}
