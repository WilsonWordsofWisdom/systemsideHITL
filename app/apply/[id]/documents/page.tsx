import Link from "next/link";
import {
  CsrfField,
  ErrorNotice,
  JourneyLayout,
  NextStep,
  Notice,
  btn,
  fieldLabel,
} from "@/components/journey";
import { documents, loadOwnApplication } from "@/lib/journey/page";

// Step 4: supporting document. Only the file's name, type and size are kept.
export default async function DocumentsPage({
  params,
  searchParams,
}: PageProps<"/apply/[id]/documents">) {
  const { id } = await params;
  const query = await searchParams;
  const { app, csrf } = await loadOwnApplication(id);
  const docs = documents(app);

  return (
    <JourneyLayout step="documents">
      <h1 className="mb-4 text-[28px] leading-9">Supporting document</h1>
      <ErrorNotice code={query.error} />
      {query.added === "1" && <Notice tone="success" title="Document added" />}
      <p className="mb-4">
        Add a site plan or similar (PDF, PNG, JPEG or text, up to 2 MB). This prototype keeps only
        the file name, type and size.
      </p>

      {docs.length > 0 && (
        <ul className="mb-6 rounded-xl border border-outline-variant bg-white">
          {docs.map((d, i) => (
            <li key={i} className="border-b border-outline-variant px-6 py-3 last:border-0">
              {d.name}{" "}
              <span className="text-sm text-on-surface-variant">
                ({Math.ceil(d.size / 1024)} KB)
              </span>
            </li>
          ))}
        </ul>
      )}

      {app.status === "draft" && (
        <form
          action={`/api/applications/${app.id}/documents`}
          method="post"
          encType="multipart/form-data"
          className="mb-6 space-y-3"
        >
          <CsrfField csrf={csrf} />
          <div>
            <label htmlFor="document" className={fieldLabel}>
              Choose a file
            </label>
            <input
              id="document"
              name="document"
              type="file"
              required
              accept=".pdf,.png,.jpg,.jpeg,.txt"
            />
          </div>
          <button type="submit" className={btn.outlined}>
            Upload document
          </button>
        </form>
      )}

      <Link href={`/apply/${app.id}/review`} className={btn.filled}>
        Continue to review
      </Link>
      <NextStep href={`/apply/${app.id}/review`} label="Review your answers" />
    </JourneyLayout>
  );
}
