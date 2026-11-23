import Link from "next/link";
import { HandoffPanel, loadHandoff } from "@/components/handoff";
import { CsrfField, ErrorNotice, JourneyLayout, NextStep, btn } from "@/components/journey";
import { loadOwnApplication } from "@/lib/journey/page";

// Step 9: confirm deletion on its own page (no modal-only flows, FR28).
export default async function DeletePage({
  params,
  searchParams,
}: PageProps<"/applications/[id]/delete">) {
  const { id } = await params;
  const query = await searchParams;
  const current = await loadOwnApplication(id);
  const { app, csrf } = current;
  const handoff = await loadHandoff(query.ticket, current);

  return (
    <JourneyLayout step="applications">
      <h1 className="mb-4 text-[28px] leading-9">Delete this application?</h1>
      <ErrorNotice code={query.error} />
      <p className="mb-6">
        <strong>{app.title}</strong> will be removed from your applications. This can&apos;t be
        undone.
      </p>
      {handoff ? (
        <HandoffPanel ticket={handoff} />
      ) : (
        <div className="flex flex-wrap gap-3">
          <form action={`/api/applications/${app.id}/delete`} method="post">
            <CsrfField csrf={csrf} />
            <button type="submit" className={btn.danger}>
              Delete application
            </button>
          </form>
          <Link href={`/applications/${app.id}`} className={btn.text}>
            Cancel
          </Link>
        </div>
      )}
      <NextStep href="/applications" label="Your applications" />
    </JourneyLayout>
  );
}
