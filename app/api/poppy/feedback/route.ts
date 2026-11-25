import { getSessionSecret } from "@/lib/auth/crypto";
import { runIdFromRequest } from "@/lib/console/run";
import { getDb } from "@/lib/db/server";
import { poppyOn } from "@/lib/flags";
import { clientIp, ipHash } from "@/lib/http";
import { FEEDBACK_LIMIT, FeedbackBody, recordFeedback } from "@/lib/poppy/feedback";
import { notFound, poppyError, versionProblem } from "@/lib/poppy/version";
import { retryAfter } from "@/lib/ratelimit";

const MAX_BODY = 4 * 1024;

// Poppy task feedback (Poppy 1.0 section 9.3, FR42): logged to request_log for the
// console; 202 with no body. Changes no journey state.
export async function POST(request: Request) {
  if (!poppyOn()) return notFound();
  const problem = versionProblem(request);
  if (problem) return problem;

  const text = await request.text().catch(() => "");
  let raw: unknown = null;
  try {
    raw = text.length <= MAX_BODY ? JSON.parse(text) : null;
  } catch {
    raw = null;
  }
  const parsed = FeedbackBody.safeParse(raw);
  if (!parsed.success) return poppyError("invalid_request", 400);

  const now = new Date();
  const until = await recordFeedback(
    getDb(),
    parsed.data,
    {
      ipHash: ipHash(clientIp(request), getSessionSecret()),
      userAgent: request.headers.get("user-agent") ?? "",
      runId: runIdFromRequest(request),
    },
    now,
  );
  if (until) {
    return poppyError("rate_limited", 429, {
      "Retry-After": retryAfter(until, now, FEEDBACK_LIMIT.lockSec),
    });
  }
  return new Response(null, { status: 202 });
}
