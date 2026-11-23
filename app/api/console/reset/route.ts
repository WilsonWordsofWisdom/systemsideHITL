import { NextResponse } from "next/server";
import { appConfig } from "@/lib/app";
import { getSessionSecret } from "@/lib/auth/crypto";
import { requireAdminRequest } from "@/lib/console/current";
import { resetDemoData } from "@/lib/console/reset";
import { getDb } from "@/lib/db/server";
import { clientIp, ipHash, readBody } from "@/lib/http";
import { logEvent } from "@/lib/log";

// "Reset demo data" (FR39, control L3): admin only, needs the explicit
// confirmation field, and is itself logged (after the log is cleared).
export async function POST(request: Request) {
  const body = await readBody(request).catch(() => ({}) as Record<string, string>);
  const refused = await requireAdminRequest(request, body.csrf);
  if (refused) return refused;
  if (body.confirm !== "reset") {
    return NextResponse.json({ error: "confirmation_required" }, { status: 400 });
  }
  const db = getDb();
  const removed = await resetDemoData(db);
  await logEvent(db, {
    route: "web",
    method: "POST",
    pathOrTool: "console_reset",
    outcome: "executed",
    reason: "demo_data_reset",
    actorSignals: { removed },
    userAgent: (request.headers.get("user-agent") ?? "").slice(0, 300),
    ipHash: ipHash(clientIp(request), getSessionSecret()),
  });
  return NextResponse.redirect(new URL("/console?reset=1", appConfig().appOrigin), 303);
}
