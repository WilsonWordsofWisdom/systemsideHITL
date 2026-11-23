import { NextResponse } from "next/server";
import { getCurrentSession } from "@/lib/auth/current";
import { getDb } from "@/lib/db/server";
import { getTicket } from "@/lib/hitl/tickets";

// Ticket status for polling (spec section 8). Only the ticket's own user can
// read it; anyone else gets "not found", so ticket IDs can't be probed.
export async function GET(_request: Request, ctx: RouteContext<"/api/hitl/[ticketId]">) {
  const { ticketId } = await ctx.params;
  const current = await getCurrentSession();
  if (!current) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ticket = await getTicket(getDb(), ticketId);
  if (!ticket || ticket.userId !== current.user.id) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json(
    {
      ticket_id: ticket.id,
      state: ticket.state,
      action: ticket.action,
      expires_at: ticket.expiresAt.toISOString(),
      reason: ticket.rejectReason,
      preview: ticket.payloadPreview,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
