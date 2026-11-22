"use client";

import { startRegistration } from "@simplewebauthn/browser";
import { useRouter } from "next/navigation";
import { useState } from "react";

const REASONS: Record<string, string> = {
  enrolment_closed: "Adding passkeys is turned off.",
  signin_not_fresh: "For your security, sign in again before adding a passkey.",
};

export function EnrolButton({ csrf, disabled }: { csrf: string; disabled: boolean }) {
  const router = useRouter();
  const [message, setMessage] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

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
      const start = await post("/api/passkeys/register/options");
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
      if (!finish.ok) throw new Error();
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
