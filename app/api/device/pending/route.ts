import { NextResponse } from "next/server";
import { getApproverSession } from "@/lib/auth/current";
import { getDb } from "@/lib/db/server";
import { pendingIds } from "@/lib/hitl/device";

export const dynamic = "force-dynamic";

// The phone page's polling fallback (FR22): the signed-in approver's pending
// ticket IDs. Always the approver's own account, so nothing in the URL selects it.
export async function GET() {
  const viewer = await getApproverSession();
  if (!viewer) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json(
    { pending: await pendingIds(getDb(), viewer.user.id) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
