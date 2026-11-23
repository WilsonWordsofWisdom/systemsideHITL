import Link from "next/link";
import { JourneyLayout, NextStep, Notice, btn } from "@/components/journey";
import { details, documents, loadOwnApplication } from "@/lib/journey/page";
import { isComplete } from "@/lib/journey/service";

// Step 5: review answers before the declaration.
export default async function ReviewPage({ params }: PageProps<"/apply/[id]/review">) {
  const { id } = await params;
  const { app } = await loadOwnApplication(id);
  const d = details(app);
  const docs = documents(app);
  const complete = isComplete(app);

  return (
    <JourneyLayout step="review">
      <h1 className="mb-4 text-[28px] leading-9">Review your application</h1>
      {!complete && (
        <Notice tone="warn" title="Some event details are missing">
          <Link href={`/apply/${app.id}/details`} className="underline">
            Add the missing details
          </Link>
        </Notice>
      )}
      <dl className="mb-6 grid grid-cols-[180px_1fr] border-t border-outline-variant">
        {[
          ["Event name", app.title],
          ["Date", d.date ?? "Not given"],
          ["Expected attendance", d.attendance ? `${d.attendance} people` : "Not given"],
          ["Location", d.location ?? "Not given"],
          ["Supporting document", docs.length ? docs.map((x) => x.name).join(", ") : "None"],
        ].map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="border-b border-outline-variant py-3 text-on-surface-variant">{k}</dt>
            <dd className="border-b border-outline-variant py-3">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap gap-3">
        <Link href={`/apply/${app.id}/declare`} className={btn.filled}>
          Continue to declaration
        </Link>
        <Link href={`/apply/${app.id}/details`} className={btn.text}>
          Change details
        </Link>
      </div>
      <NextStep href={`/apply/${app.id}/declare`} label="Declaration" />
    </JourneyLayout>
  );
}
