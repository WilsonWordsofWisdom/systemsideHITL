import Link from "next/link";
import {
  CsrfField,
  ErrorNotice,
  JourneyLayout,
  NextStep,
  Notice,
  btn,
  fieldInput,
  fieldLabel,
} from "@/components/journey";
import { details, loadOwnApplication } from "@/lib/journey/page";

// Step 3: event details.
export default async function DetailsPage({
  params,
  searchParams,
}: PageProps<"/apply/[id]/details">) {
  const { id } = await params;
  const query = await searchParams;
  const { app, csrf } = await loadOwnApplication(id);
  const d = details(app);
  const editable = app.status === "draft";
  const fields = [
    {
      name: "title",
      label: "Event name",
      type: "text",
      value: app.title === "New application" ? "" : app.title,
    },
    { name: "date", label: "Event date", type: "date", value: d.date ?? "" },
    {
      name: "attendance",
      label: "Expected attendance (people)",
      type: "number",
      value: d.attendance?.toString() ?? "",
    },
    { name: "location", label: "Location", type: "text", value: d.location ?? "" },
  ];

  return (
    <JourneyLayout step="details">
      <h1 className="mb-4 text-[28px] leading-9">Event details</h1>
      <ErrorNotice code={query.error} />
      {!editable ? (
        <Notice tone="info" title="This application can no longer be edited">
          <Link href={`/applications/${app.id}`} className="underline">
            View the application
          </Link>
        </Notice>
      ) : (
        <form action={`/api/applications/${app.id}/details`} method="post" className="space-y-4">
          <CsrfField csrf={csrf} />
          {fields.map((f) => (
            <div key={f.name}>
              <label htmlFor={f.name} className={fieldLabel}>
                {f.label}
              </label>
              <input
                id={f.name}
                name={f.name}
                type={f.type}
                defaultValue={f.value}
                required
                min={f.type === "number" ? 1 : undefined}
                className={fieldInput}
              />
            </div>
          ))}
          <button type="submit" className={btn.filled}>
            Save and continue
          </button>
        </form>
      )}
      <NextStep href={`/apply/${app.id}/documents`} label="Supporting document" />
    </JourneyLayout>
  );
}
