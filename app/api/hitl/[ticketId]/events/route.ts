import { getApproverSession } from "@/lib/auth/current";
import { getDb } from "@/lib/db/server";
import { getTicket, type Ticket } from "@/lib/hitl/tickets";

export const dynamic = "force-dynamic";
// Streams are short-lived so they fit serverless limits (architecture risk 2).
export const maxDuration = 30;

const STREAM_MS = 25_000;
const CHECK_MS = 1_500;

const view = (t: Ticket) => ({
  state: t.state,
  reason: t.rejectReason,
  expires_at: t.expiresAt.toISOString(),
});

// Server-sent events for one ticket's state (spec section 8). Sends `state` on
// every change and `reconnect` before closing; clients reopen the stream, and fall
// back to polling GET /api/hitl/[ticketId] if it fails (architecture section 8).
export async function GET(request: Request, ctx: RouteContext<"/api/hitl/[ticketId]/events">) {
  const { ticketId } = await ctx.params;
  const viewer = await getApproverSession();
  const db = getDb();
  const first = await getTicket(db, ticketId);
  if (!viewer || !first || first.userId !== viewer.user.id) {
    return new Response("not found", { status: 404 });
  }

  const encoder = new TextEncoder();
  let cancelled = false;
  const stream = new ReadableStream({
    cancel() {
      // The client went away: stop polling the database.
      cancelled = true;
    },
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (cancelled) throw new Error("stream closed");
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      let last = JSON.stringify(view(first));
      send("state", view(first));
      const started = Date.now();
      try {
        while (!cancelled && !request.signal.aborted && Date.now() - started < STREAM_MS) {
          await new Promise((r) => setTimeout(r, CHECK_MS));
          const t = await getTicket(db, ticketId);
          if (!t) break;
          const next = JSON.stringify(view(t));
          if (next !== last) {
            last = next;
            send("state", view(t));
          }
          if (t.state !== "pending") break;
        }
        if (!cancelled && !request.signal.aborted) send("reconnect", {});
      } catch {
        // Closed by the client, or a read failed; the client falls back to polling.
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
