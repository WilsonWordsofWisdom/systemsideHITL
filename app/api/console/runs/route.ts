import { NextResponse } from "next/server";
import { appConfig } from "@/lib/app";
import { requireAdminRequest } from "@/lib/console/current";
import { setRunLabel } from "@/lib/console/queries";
import { validRunId } from "@/lib/console/run";
import { getDb } from "@/lib/db/server";
import { readBody } from "@/lib/http";

// Sets a run's ground truth (FR16, FR40): which agent really drove it and who was
// acting. Test metadata only; the classifier never reads it.
export async function POST(request: Request) {
  const body = await readBody(request).catch(() => ({}) as Record<string, string>);
  const refused = await requireAdminRequest(request, body.csrf);
  if (refused) return refused;
  const run = validRunId(body.run);
  if (!run) return NextResponse.json({ error: "invalid_run" }, { status: 400 });
  await setRunLabel(getDb(), run, {
    agentLabel: body.agentLabel,
    actualActor: body.actualActor,
    notes: body.notes,
  });
  return NextResponse.redirect(
    new URL(`/console?run=${encodeURIComponent(run)}`, appConfig().appOrigin),
    303,
  );
}
