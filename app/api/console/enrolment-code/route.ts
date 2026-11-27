import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionSecret } from "@/lib/auth/crypto";
import { ENROLMENT_CODE_TTL_MS, issueEnrolmentCode } from "@/lib/auth/enrolment-codes";
import { requireAdminRequest } from "@/lib/console/current";
import { users } from "@/lib/db/schema";
import { getDb } from "@/lib/db/server";
import { clientIp, ipHash } from "@/lib/http";
import { logEvent } from "@/lib/log";

const Body = z.object({ email: z.string().trim().toLowerCase().email().max(200) });

// Issues a one-time passkey enrolment code for one account (gap H1, control
// W12): admin only, returned once in the response and never stored or logged in
// clear. The admin gives it to the person out of band.
export async function POST(request: Request) {
  const refused = await requireAdminRequest(request);
  if (refused) return refused;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_email" }, { status: 400 });

  const db = getDb();
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, parsed.data.email))
    .limit(1);
  if (!user) return NextResponse.json({ error: "unknown_account" }, { status: 404 });

  const { code, expiresAt } = await issueEnrolmentCode(db, user.id);
  await logEvent(db, {
    route: "web",
    method: "POST",
    pathOrTool: "console_enrolment_code",
    userId: user.id,
    outcome: "executed",
    reason: "enrolment_code_issued",
    actorSignals: { ttlMinutes: ENROLMENT_CODE_TTL_MS / 60_000 },
    userAgent: (request.headers.get("user-agent") ?? "").slice(0, 300),
    ipHash: ipHash(clientIp(request), getSessionSecret()),
  });
  return NextResponse.json(
    { code, expiresAt: expiresAt.toISOString() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
