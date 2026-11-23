import Link from "next/link";
import { HandoffPanel, loadHandoff } from "@/components/handoff";
import { CsrfField, ErrorNotice, JourneyLayout, NextStep, Notice, btn } from "@/components/journey";
import { loadOwnApplication } from "@/lib/journey/page";

// Step 6: the legal declaration. In Phase 2 a gated submit replaces this form
// with the human approval handoff panel (design.md 4.5).
export default async function DeclarePage({
  params,
  searchParams,
}: PageProps<"/apply/[id]/declare">) {
  const { id } = await params;
  const query = await searchParams;
  const current = await loadOwnApplication(id);
  const { app, csrf } = current;
  const handoff = await loadHandoff(query.ticket, current);

  return (
    <JourneyLayout step="declare">
      <h1 className="mb-4 text-[28px] leading-9">Declaration</h1>
      <ErrorNotice code={query.error} />
      {app.status !== "draft" ? (
        <Notice tone="info" title="This application has been submitted">
          <Link href={`/apply/${app.id}/pay`} className="underline">
            Go to payment
          </Link>
        </Notice>
      ) : handoff ? (
        <HandoffPanel ticket={handoff} csrf={csrf} />
      ) : (
        <form action={`/api/applications/${app.id}/submit`} method="post" className="space-y-4">
          <CsrfField csrf={csrf} />
          <p>
            You are applying for a Community Event Permit for <strong>{app.title}</strong>.
            Submitting this application is a legal declaration.
          </p>
          <div className="flex items-start gap-3">
            <input
              id="declaration"
              name="declaration"
              type="checkbox"
              required
              className="mt-1 h-[18px] w-[18px]"
            />
            <label htmlFor="declaration">
              I declare that the information I have given is true and complete.
            </label>
          </div>
          <button type="submit" className={btn.filled}>
            Submit application
          </button>
        </form>
      )}
      <NextStep href={`/apply/${app.id}/pay`} label="Pay the fee" />
    </JourneyLayout>
  );
}
