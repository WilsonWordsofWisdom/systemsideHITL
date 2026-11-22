import { NextResponse } from "next/server";
import { appConfig } from "@/lib/app";
import { getSessionSecret } from "@/lib/auth/crypto";
import { getCurrentSession } from "@/lib/auth/current";
import { verifyCsrf } from "@/lib/auth/session";
import { clientSignals } from "@/lib/db/schema";
import { getDb } from "@/lib/db/server";
import { isSameOrigin } from "@/lib/http";
import { headerFacts, parseSignals } from "@/lib/signals";

// Receives behaviour signals from public/signals.js for signed-in sessions (FR9).
// The classifier reads them in Phase 2.
export async function POST(request: Request) {
  if (!isSameOrigin(request, appConfig().appOrigin)) {
    return NextResponse.json({ error: "bad_request" }, { status: 403 });
  }
  const current = await getCurrentSession();
  if (!current) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!verifyCsrf(current.session.id, request.headers.get("x-csrf-token"), getSessionSecret())) {
    return NextResponse.json({ error: "csrf" }, { status: 403 });
  }
  // A page closing mid-request aborts the body; that is normal for the final
  // pagehide beacon, so it is treated as an empty payload, not an error.
  const raw = await request.text().catch(() => "");
  const signals = parseSignals(raw);
  if (!signals) return NextResponse.json({ error: "invalid" }, { status: 400 });
  await getDb()
    .insert(clientSignals)
    .values({
      sessionId: current.session.id,
      payload: { ...signals, headers: headerFacts(request) },
    });
  return new NextResponse(null, { status: 204 });
}
