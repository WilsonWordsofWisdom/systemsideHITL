// Console queries (FR39, FR40). Read-only except setRunLabel, which writes test
// metadata the classifier never reads (A6).
import { and, desc, eq, inArray, isNotNull, like, type SQL } from "drizzle-orm";
import { requestLog, runs, sessions } from "../db/schema";
import type { AppDb } from "../db/types";
import { validRunId } from "./run";

export interface RequestFilters {
  run?: string | null;
  agent?: string | null;
  session?: string | null;
}

export type RequestRow = typeof requestLog.$inferSelect;

export const TABLE_LIMIT = 200;
export const EXPORT_LIMIT = 5000;

// Session IDs are SHA-256 hex; the filter matches a prefix, as the table shows.
const sessionPrefix = (s: string | null | undefined) =>
  s && /^[0-9a-f]{4,64}$/.test(s) ? s : null;

export async function listRequests(db: AppDb, f: RequestFilters, limit = TABLE_LIMIT) {
  const where: SQL[] = [];
  const run = validRunId(f.run);
  if (run) where.push(eq(requestLog.runId, run));
  if (f.agent) {
    const labelled = await db
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.agentLabel, f.agent));
    if (labelled.length === 0) return [];
    where.push(
      inArray(
        requestLog.runId,
        labelled.map((r) => r.id),
      ),
    );
  }
  const prefix = sessionPrefix(f.session);
  if (prefix) where.push(like(requestLog.sessionId, `${prefix}%`));
  return db
    .select()
    .from(requestLog)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(requestLog.ts))
    .limit(limit);
}

// Every run ID seen in requests or sessions, with its ground truth if set.
export async function listRuns(db: AppDb) {
  const seen = await db
    .selectDistinct({ id: requestLog.runId })
    .from(requestLog)
    .where(isNotNull(requestLog.runId));
  const fromSessions = await db
    .selectDistinct({ id: sessions.runId })
    .from(sessions)
    .where(isNotNull(sessions.runId));
  const labelled = await db.select().from(runs);
  const byId = new Map(labelled.map((r) => [r.id, r]));
  for (const { id } of [...seen, ...fromSessions]) {
    if (id && !byId.has(id)) {
      byId.set(id, {
        id,
        agentLabel: null,
        actualActor: null,
        notes: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      });
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export const ACTUAL_ACTORS = ["agent", "human", "mixed"] as const;

// Ground truth for a run, set by the tester (FR16). Never an input to the classifier.
export async function setRunLabel(
  db: AppDb,
  runId: string,
  input: { agentLabel?: string; actualActor?: string; notes?: string },
  now = new Date(),
) {
  const id = validRunId(runId);
  if (!id) throw new Error("invalid run ID");
  const clean = (v: string | undefined, max: number) => v?.trim().slice(0, max) || null;
  const actor = ACTUAL_ACTORS.find((a) => a === input.actualActor) ?? null;
  const values = {
    agentLabel: clean(input.agentLabel, 120),
    actualActor: actor,
    notes: clean(input.notes, 1000),
    updatedAt: now,
  };
  await db
    .insert(runs)
    .values({ id, ...values, createdAt: now })
    .onConflictDoUpdate({ target: runs.id, set: values });
}

const SHORT: Record<string, string> = {
  webdriver: "webdriver",
  untrusted_events: "untrusted events",
  no_pointer_before_click: "no pointer",
  fast_completion: "fast",
  regular_timing: "regular timing",
  missing_browser_headers: "missing headers",
  agent_ua_token: "agent UA",
  client_context_changed: "ctx changed",
  no_prior_page_view: "no page view",
};

// One-line summary of a row's signals for the table (the full JSON is exported).
export function signalsSummary(signals: unknown): string {
  const s = (signals ?? {}) as {
    tier?: string;
    score?: number;
    contributions?: Record<string, number>;
    sticky?: boolean;
    riskChange?: { to?: string } | null;
    facts?: { classifierError?: boolean; selfDeclared?: boolean };
  };
  if (s.facts?.classifierError) return "classifier error";
  const parts: string[] = [];
  if (s.tier === "A") parts.push("protocol identity");
  if (s.tier === "B") parts.push("self-declared");
  const hits = Object.keys(s.contributions ?? {}).map((k) => SHORT[k] ?? k);
  if (hits.length) parts.push(hits.join(", "));
  if (typeof s.score === "number") parts.push(`score ${s.score}`);
  if (s.sticky) parts.push("carried over");
  if (s.riskChange?.to) parts.push(`risk → ${s.riskChange.to}`);
  return parts.join(" · ") || "–";
}

// Export rows: IPs stay hashed and nothing secret is stored in request_log (L4).
export function exportRow(r: RequestRow) {
  return {
    time: r.ts.toISOString(),
    route: r.route,
    method: r.method,
    path_or_tool: r.pathOrTool,
    run_id: r.runId,
    session_id: r.sessionId,
    user_id: r.userId,
    actor_class: r.actorClass,
    policy_decision: r.policyDecision,
    ticket_id: r.ticketId,
    outcome: r.outcome,
    reason: r.reason,
    latency_ms: r.latencyMs,
    user_agent: r.userAgent,
    ip_hash: r.ipHash,
    signals: r.actorSignals,
  };
}

export function toCsv(rows: ReturnType<typeof exportRow>[]): string {
  const headers = [
    "time",
    "route",
    "method",
    "path_or_tool",
    "run_id",
    "session_id",
    "user_id",
    "actor_class",
    "policy_decision",
    "ticket_id",
    "outcome",
    "reason",
    "latency_ms",
    "user_agent",
    "ip_hash",
    "signals",
  ] as const;
  const cell = (v: unknown) => {
    const text =
      v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    // Quote every cell; neutralise spreadsheet formulas (CSV injection).
    const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  return [headers.join(","), ...rows.map((r) => headers.map((h) => cell(r[h])).join(","))].join(
    "\r\n",
  );
}
