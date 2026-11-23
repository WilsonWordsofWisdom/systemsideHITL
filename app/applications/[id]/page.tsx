import Link from "next/link";
import { JourneyLayout, NextStep, Notice, StatusChip, btn } from "@/components/journey";
import { details, documents, loadOwnApplication } from "@/lib/journey/page";
import { journeyState } from "@/lib/journey/service";

const NEXT: Record<string, { href: (id: string) => string; label: string }> = {
  details: { href: (id) => `/apply/${id}/details`, label: "Event details" },
  review: { href: (id) => `/apply/${id}/review`, label: "Review your answers" },
  pay: { href: (id) => `/apply/${id}/pay`, label: "Pay the fee" },
};

// One application (steps 2 and 5).
export default async function ApplicationPage({
  params,
  searchParams,
}: PageProps<"/applications/[id]">) {
  const { id } = await params;
  const query = await searchParams;
  const { app } = await loadOwnApplication(id);
  const d = details(app);
  const docs = documents(app);
  const next = NEXT[journeyState(app).step];

  return (
    <JourneyLayout step="applications">
      <h1 className="mb-2 text-[28px] leading-9">{app.title}</h1>
      <p className="mb-6">
        <StatusChip status={app.status} />
      </p>
      {query.paid === "1" && (
        <Notice tone="success" title="Payment received">
          Your application is complete. Reference {d.payment?.reference}.
        </Notice>
      )}

      <dl className="mb-6 grid grid-cols-[180px_1fr] border-t border-outline-variant">
        {[
          ["Date", d.date ?? "Not given"],
          ["Expected attendance", d.attendance ? `${d.attendance} people` : "Not given"],
          ["Location", d.location ?? "Not given"],
          ["Documents", docs.length ? docs.map((x) => x.name).join(", ") : "None"],
          ...(d.payment ? [["Fee paid", `$${d.payment.amount} (${d.payment.reference})`]] : []),
        ].map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="border-b border-outline-variant py-3 text-on-surface-variant">{k}</dt>
            <dd className="border-b border-outline-variant py-3">{v}</dd>
          </div>
        ))}
      </dl>

      <div className="flex flex-wrap gap-3">
        {next && (
          <Link href={next.href(app.id)} className={btn.filled}>
            Continue: {next.label}
          </Link>
        )}
        <Link href={`/applications/${app.id}/delete`} className={btn.danger}>
          Delete application
        </Link>
      </div>
      <NextStep
        href={next ? next.href(app.id) : "/applications"}
        label={next ? next.label : "Your applications"}
      />
    </JourneyLayout>
  );
}
