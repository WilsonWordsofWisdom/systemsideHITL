"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

const POLL_MS = 3_000;

// Keeps the phone page current (FR22, design.md 4.7): SSE first, polling when the
// stream fails. When the set of pending requests changes, the page re-renders
// from the server, so cards always come from the ticket rows.
export function DeviceLive({ initial }: { initial: string[] }) {
  const router = useRouter();
  const [polling, setPolling] = useState(false);
  const known = useRef(initial.join());

  useEffect(() => {
    let es: EventSource | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let stopped = false;
    const apply = (ids: string[]) => {
      const key = ids.join();
      if (key !== known.current) {
        known.current = key;
        router.refresh();
      }
    };
    const startPolling = () => {
      if (poll || stopped) return;
      setPolling(true);
      poll = setInterval(async () => {
        const res = await fetch("/api/device/pending", { cache: "no-store" }).catch(() => null);
        if (res?.ok) apply((await res.json()).pending);
      }, POLL_MS);
    };
    const open = () => {
      if (stopped) return;
      if (typeof EventSource === "undefined") return startPolling();
      es = new EventSource("/api/device/events");
      es.addEventListener("pending", (e) => apply(JSON.parse((e as MessageEvent).data).pending));
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
    return () => {
      stopped = true;
      es?.close();
      if (poll) clearInterval(poll);
    };
  }, [router]);

  if (!polling) return null;
  return (
    <p
      role="status"
      className="mb-4 rounded-xl bg-warning-container px-4 py-3 text-sm text-on-warning-container"
    >
      <strong>Reconnecting.</strong> Checking for new requests every few seconds.
    </p>
  );
}
