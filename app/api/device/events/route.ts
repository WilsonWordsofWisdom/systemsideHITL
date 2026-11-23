import { getApproverSession } from "@/lib/auth/current";
import { getDb } from "@/lib/db/server";
import { pendingIds } from "@/lib/hitl/device";

export const dynamic = "force-dynamic";
// Streams are short-lived so they fit serverless limits (architecture risk 2).
export const maxDuration = 30;

const STREAM_MS = 25_000;
const CHECK_MS = 1_000;

// Server-sent events for the phone page (FR22, J05): `pending` with the approver's
// pending ticket IDs on every change, then `reconnect` before closing. The page
// falls back to polling GET /api/device/pending if the stream fails.
export async function GET(request: Request) {
  const viewer = await getApproverSession();
  if (!viewer) return new Response("unauthorized", { status: 401 });
  const db = getDb();
  const userId = viewer.user.id;

  const encoder = new TextEncoder();
  let cancelled = false;
  const stream = new ReadableStream({
    cancel() {
      cancelled = true;
    },
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (cancelled) throw new Error("stream closed");
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      try {
        let last = await pendingIds(db, userId);
        send("pending", { pending: last });
        const started = Date.now();
        while (!cancelled && !request.signal.aborted && Date.now() - started < STREAM_MS) {
          await new Promise((r) => setTimeout(r, CHECK_MS));
          const next = await pendingIds(db, userId);
          if (next.join() !== last.join()) {
            last = next;
            send("pending", { pending: next });
          }
        }
        if (!cancelled && !request.signal.aborted) send("reconnect", {});
      } catch {
        // Closed by the client, or a read failed; the page falls back to polling.
      } finally {
        if (!cancelled) controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    },
  });
}
