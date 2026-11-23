import { NextResponse } from "next/server";
import { requireAdminRequest } from "@/lib/console/current";
import { EXPORT_LIMIT, exportRow, listRequests, toCsv } from "@/lib/console/queries";
import { getDb } from "@/lib/db/server";

// Exports the current console view as CSV or JSON (FR39, control L4): the same
// filters as the table, IPs hashed, no secrets.
export async function GET(request: Request) {
  const refused = await requireAdminRequest(request);
  if (refused) return refused;
  const q = new URL(request.url).searchParams;
  const rows = (
    await listRequests(
      getDb(),
      { run: q.get("run"), agent: q.get("agent"), session: q.get("session") },
      EXPORT_LIMIT,
    )
  ).map(exportRow);
  const name = `hitl-requests-${q.get("run") || "all"}`.replace(/[^A-Za-z0-9_-]/g, "_");
  const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };
  if (q.get("format") === "csv") {
    return new NextResponse(toCsv(rows), {
      headers: {
        ...headers,
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${name}.csv"`,
      },
    });
  }
  return NextResponse.json(rows, {
    headers: { ...headers, "Content-Disposition": `attachment; filename="${name}.json"` },
  });
}
