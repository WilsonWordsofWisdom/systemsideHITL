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
