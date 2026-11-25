// Poppy task feedback (Poppy 1.0 section 9.3; FR42). A report that an agent could
// not do a task. It is logged for the console and changes no journey state.
import { z } from "zod";
import type { AppDb } from "@/lib/db/types";
import { logEvent } from "@/lib/log";
import { lockedUntil, recordFailure, type LimitRule } from "@/lib/ratelimit";

export const FeedbackBody = z.object({
  task: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(2000),
});
export type Feedback = z.infer<typeof FeedbackBody>;

// Reports per IP hash: plenty for testers, a brake on floods.
export const FEEDBACK_LIMIT: LimitRule = { max: 30, windowSec: 3600, lockSec: 3600 };

export interface FeedbackMeta {
  ipHash: string;
  userAgent: string;
  runId: string | null;
}

// Returns the time the caller may try again, or null when the report was logged.
export async function recordFeedback(
  db: AppDb,
  feedback: Feedback,
  meta: FeedbackMeta,
  now = new Date(),
): Promise<Date | null> {
  const key = `poppy:feedback:${meta.ipHash}`;
  const until = await lockedUntil(db, key, now);
  if (until) return until;
  await recordFailure(db, key, FEEDBACK_LIMIT, now);
  await logEvent(db, {
    route: "api",
    method: "POST",
    pathOrTool: "poppy_feedback",
    runId: meta.runId,
    outcome: "executed",
    reason: "task_feedback",
    actorSignals: { poppy: { task: feedback.task, description: feedback.description } },
    userAgent: meta.userAgent.slice(0, 300),
    ipHash: meta.ipHash,
  });
  return null;
}
