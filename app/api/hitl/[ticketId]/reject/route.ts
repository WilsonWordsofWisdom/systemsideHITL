import { NextResponse } from "next/server";
import { appConfig } from "@/lib/app";
import { approveContext } from "@/lib/hitl/approve-request";
import { rejectTicket } from "@/lib/hitl/tickets";
import { readBody, wantsHtml } from "@/lib/http";

// The human declines (spec 8): pending -> rejected. Forms are sent back to the
// approval page; API callers get JSON.
export async function POST(request: Request, ctx: RouteContext<"/api/hitl/[ticketId]/reject">) {
  const { ticketId } = await ctx.params;
  const body = await readBody(request).catch(() => ({}) as Record<string, string>);
  const checked = await approveContext(request, ticketId, body.csrf);
  if (!checked.ok) return checked.response;
  const { db, ticket, now, record } = checked.ctx;

  const rejected = await rejectTicket(db, ticket.id, "declined", now);
  await record(rejected ? "executed" : "blocked", rejected ? "declined" : `state:${ticket.state}`);
  if (wantsHtml(request)) {
    return NextResponse.redirect(new URL(`/approve/${ticket.id}`, appConfig().appOrigin), 303);
  }
  return rejected
    ? NextResponse.json({ ok: true, state: "rejected" })
    : NextResponse.json({ error: "not_pending", state: ticket.state }, { status: 409 });
}
