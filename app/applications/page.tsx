import Link from "next/link";
import {
  CsrfField,
  ErrorNotice,
  JourneyLayout,
  NextStep,
  Notice,
  StatusChip,
  btn,
  fieldInput,
  fieldLabel,
} from "@/components/journey";
import { requireSession } from "@/lib/auth/current";
import { getDb } from "@/lib/db/server";
import { listApplications } from "@/lib/journey/service";

// Step 2: browse and search applications.
export default async function ApplicationsPage({ searchParams }: PageProps<"/applications">) {
  const { user, csrf } = await requireSession();
  const params = await searchParams;
  const q = typeof params.q === "string" ? params.q : "";
  const apps = await listApplications(getDb(), user.id, q);

  return (
    <JourneyLayout step="applications">
      <h1 className="mb-4 text-[28px] leading-9">Your applications</h1>
      <ErrorNotice code={params.error} />
      {params.deleted === "1" && <Notice tone="success" title="Application deleted" />}

      <form action="/applications" method="get" className="mb-6 flex items-end gap-3">
        <div className="flex-1">
          <label htmlFor="q" className={fieldLabel}>
            Search applications
          </label>
          <input id="q" name="q" type="search" defaultValue={q} className={fieldInput} />
        </div>
        <button type="submit" className={btn.outlined}>
          Search
        </button>
      </form>

      {apps.length === 0 ? (
        <p className="mb-6 rounded-xl border border-outline-variant bg-white p-6 text-on-surface-variant">
          {q ? "No applications match your search." : "You don't have any applications yet."}
        </p>
      ) : (
        <ul className="mb-6 rounded-xl border border-outline-variant bg-white">
          {apps.map((a) => (
            <li
              key={a.id}
              className="flex items-center justify-between gap-4 border-b border-outline-variant px-6 py-4 last:border-0"
            >
              <Link
                href={`/applications/${a.id}`}
                className="font-medium text-primary underline-offset-4 hover:underline"
              >
                {a.title}
              </Link>
              <StatusChip status={a.status} />
            </li>
          ))}
        </ul>
      )}

      <form id="start" action="/api/applications" method="post">
        <CsrfField csrf={csrf} />
        <button type="submit" className={btn.filled}>
          Start a new application
        </button>
      </form>
      <NextStep href="#start" label="Start a new application" />
    </JourneyLayout>
  );
}
