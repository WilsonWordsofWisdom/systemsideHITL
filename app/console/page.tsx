import Link from "next/link";
import { ClassChip, DecisionChip, ObserveBanner, shortAgent, shortId } from "@/components/console";
import { Notice, btn, fieldInput, fieldLabel } from "@/components/journey";
import { appConfig } from "@/lib/app";
import { getAdminSecret } from "@/lib/console/admin";
import { getAdmin } from "@/lib/console/current";
import { ACTUAL_ACTORS, listRequests, listRuns, signalsSummary } from "@/lib/console/queries";
import { validRunId } from "@/lib/console/run";
import { getDb } from "@/lib/db/server";
import { getClassifierConfig } from "@/lib/hitl/classifier";

const LOGIN_ERRORS: Record<string, string> = {
  invalid: "That admin secret isn't right.",
  locked: "Too many attempts. Try again in 10 minutes.",
  not_configured: "The console isn't set up: ADMIN_SECRET is not configured.",
  bad_request: "Sign in from this site's console page.",
};

const param = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

// /console (FR39, FR40, design.md 4.8): every request with its signals and
// decision, filtered by run, agent label or session, with export and ground truth.
export default async function ConsolePage({ searchParams }: PageProps<"/console">) {
  const q = await searchParams;
  const admin = await getAdmin();

  if (!admin) {
    const configured = getAdminSecret() !== null;
    const error = LOGIN_ERRORS[param(q.error)];
    return (
      <div className="max-w-md">
        <h1 className="mb-4 text-[28px] leading-9">Console sign-in</h1>
        {error && <Notice tone="error" title={error} />}
        {configured ? (
          <form action="/api/console/login" method="post" className="space-y-4">
            <div>
              <label htmlFor="secret" className={fieldLabel}>
                Admin secret
              </label>
              <input
                id="secret"
                name="secret"
                type="password"
                autoComplete="current-password"
                required
                className={fieldInput}
              />
            </div>
            <button type="submit" className={btn.filled}>
              Sign in to the console
            </button>
          </form>
        ) : (
          <Notice tone="warn" title="The console isn't set up">
            Set ADMIN_SECRET (at least 16 characters) in the environment.
          </Notice>
        )}
      </div>
    );
  }

  const db = getDb();
  const filters = {
    run: validRunId(param(q.run)),
    agent: param(q.agent) || null,
    session: param(q.session) || null,
  };
  const [rows, runList] = await Promise.all([listRequests(db, filters), listRuns(db)]);
  const labels = [...new Set(runList.map((r) => r.agentLabel).filter(Boolean))] as string[];
  const selectedRun = runList.find((r) => r.id === filters.run);
  const origin = appConfig().appOrigin;
  const exportQuery = new URLSearchParams(
    Object.entries(filters).filter(([, v]) => v) as [string, string][],
  ).toString();

  return (
    <>
      {appConfig().hitlMode === "observe" && <ObserveBanner />}
      <div className="mb-4 flex flex-wrap items-center gap-4">
        <h1 className="text-[28px] leading-9">Console</h1>
        <nav aria-label="Console" className="flex gap-4 text-sm">
          <Link href="/console" className="text-primary underline-offset-4 hover:underline">
            Requests
          </Link>
          <Link href="/console/policy" className="text-primary underline-offset-4 hover:underline">
            Policy
          </Link>
        </nav>
        <form action="/api/console/logout" method="post" className="ml-auto">
          <input type="hidden" name="csrf" value={admin.csrf} />
          <button type="submit" className={btn.text}>
            Sign out of the console
          </button>
        </form>
      </div>

      <form method="get" action="/console" className="mb-4 flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="run" className={fieldLabel}>
            Run
          </label>
          <select
            id="run"
            name="run"
            defaultValue={filters.run ?? ""}
            className={`${fieldInput} w-44`}
          >
            <option value="">All runs</option>
            {runList.map((r) => (
              <option key={r.id} value={r.id}>
                {r.id}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="agent" className={fieldLabel}>
            Agent label
          </label>
          <select
            id="agent"
            name="agent"
            defaultValue={filters.agent ?? ""}
            className={`${fieldInput} w-56`}
          >
            <option value="">All agents</option>
            {labels.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="session" className={fieldLabel}>
            Session (ID prefix)
          </label>
          <input
            id="session"
            name="session"
            defaultValue={filters.session ?? ""}
            className={`${fieldInput} w-44`}
          />
        </div>
        <button type="submit" className={btn.outlined}>
          Apply filters
        </button>
        <a href={`/api/console/export?format=csv&${exportQuery}`} className={btn.text}>
          Export CSV
        </a>
        <a href={`/api/console/export?format=json&${exportQuery}`} className={btn.text}>
          Export JSON
        </a>
      </form>

      {filters.run && (
        <form
          action="/api/console/runs"
          method="post"
          className="mb-4 flex flex-wrap items-end gap-3 rounded-xl border border-outline-variant bg-white p-4"
        >
          <input type="hidden" name="csrf" value={admin.csrf} />
          <input type="hidden" name="run" value={filters.run} />
          <p className="w-full text-sm text-on-surface-variant">
            Ground truth for run <strong>{filters.run}</strong>. It is shown beside the classifier
            output and never used by it. Start link: <code>{`${origin}/?run=${filters.run}`}</code>
          </p>
          <div>
            <label htmlFor="agentLabel" className={fieldLabel}>
              Agent label
            </label>
            <input
              id="agentLabel"
              name="agentLabel"
              defaultValue={selectedRun?.agentLabel ?? ""}
              placeholder="e.g. ChatGPT agent, web"
              className={`${fieldInput} w-64`}
            />
          </div>
          <div>
            <label htmlFor="actualActor" className={fieldLabel}>
              Who was acting
            </label>
            <select
              id="actualActor"
              name="actualActor"
              defaultValue={selectedRun?.actualActor ?? ""}
              className={`${fieldInput} w-40`}
            >
              <option value="">Not set</option>
              {ACTUAL_ACTORS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </div>
          <div className="min-w-64 flex-1">
            <label htmlFor="notes" className={fieldLabel}>
              Notes
            </label>
            <input
              id="notes"
              name="notes"
              defaultValue={selectedRun?.notes ?? ""}
              className={fieldInput}
            />
          </div>
          <button type="submit" className={btn.filled}>
            Save ground truth
          </button>
        </form>
      )}

      <div className="overflow-x-auto rounded-xl border border-outline-variant bg-white">
        <table className="w-full text-left text-sm">
          <caption className="px-4 py-3 text-left text-on-surface-variant">
            Requests, newest first · weights {getClassifierConfig().version}
            {selectedRun?.agentLabel && (
              <>
                {" "}
                · ground truth: <strong>{selectedRun.agentLabel}</strong>
                {selectedRun.actualActor && ` (${selectedRun.actualActor})`}
              </>
            )}
          </caption>
          <thead className="sticky top-0 bg-surface-container-high">
            <tr>
              {[
                "Time",
                "Route",
                "Agent / UA",
                "Class",
                "Signals",
                "Action",
                "Decision",
                "Ticket",
                "Outcome",
              ].map((h) => (
                <th key={h} scope="col" className="whitespace-nowrap px-3 py-2 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-3 py-6 text-on-surface-variant">
                  {filters.run ? "No requests in this run yet." : "No requests yet."}
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const signals = r.actorSignals as { action?: string };
                const wrongSession = r.reason === "ticket:wrong_session";
                return (
                  <tr key={r.id} className="border-t border-outline-variant align-top">
                    <td className="whitespace-nowrap px-3 py-2">
                      <time dateTime={r.ts.toISOString()}>{r.ts.toISOString().slice(11, 19)}</time>
                    </td>
                    <td className="px-3 py-2">{r.route}</td>
                    <td className="whitespace-nowrap px-3 py-2" title={r.userAgent ?? ""}>
                      {shortAgent(r.userAgent)}
                    </td>
                    <td className="px-3 py-2">
                      <ClassChip value={r.actorClass} />
                    </td>
                    <td className="px-3 py-2">{signalsSummary(r.actorSignals)}</td>
                    <td className="px-3 py-2">{signals.action ?? r.pathOrTool}</td>
                    <td className="px-3 py-2">
                      <DecisionChip value={r.policyDecision} />
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">
                      {shortId(r.ticketId, 12)}
                    </td>
                    <td className="px-3 py-2">
                      {r.outcome}
                      {r.reason && (
                        <span
                          className={`block text-xs ${wrongSession ? "font-medium text-[#6B4E00]" : "text-on-surface-variant"}`}
                        >
                          {wrongSession ? "wrong session (not an agent error)" : r.reason}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
