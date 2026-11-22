import {
  CsrfField,
  ErrorNotice,
  NextStep,
  Notice,
  btn,
  fieldInput,
  fieldLabel,
} from "@/components/journey";
import { requireSession } from "@/lib/auth/current";
import { getDb } from "@/lib/db/server";
import { getContact } from "@/lib/journey/service";

// Step 8: recovery contact details. Critical: Phase 2 denies this to agents.
export default async function ContactPage({ searchParams }: PageProps<"/account/contact">) {
  const { user, csrf } = await requireSession();
  const query = await searchParams;
  const contact = await getContact(getDb(), user.id);

  return (
    <>
      <h1 className="mb-4 text-[28px] leading-9">Recovery contact details</h1>
      <ErrorNotice code={query.error} />
      {query.saved === "1" && <Notice tone="success" title="Contact details saved" />}
      <p className="mb-6">These are used to recover your account if you lose access.</p>
      <form action="/api/account/contact" method="post" className="max-w-md space-y-4">
        <CsrfField csrf={csrf} />
        <div>
          <label htmlFor="recoveryEmail" className={fieldLabel}>
            Recovery email
          </label>
          <input
            id="recoveryEmail"
            name="recoveryEmail"
            type="email"
            defaultValue={contact?.recoveryEmail ?? ""}
            className={fieldInput}
          />
        </div>
        <div>
          <label htmlFor="phone" className={fieldLabel}>
            Recovery phone
          </label>
          <input
            id="phone"
            name="phone"
            type="tel"
            defaultValue={contact?.phone ?? ""}
            className={fieldInput}
          />
        </div>
        <button type="submit" className={btn.filled}>
          Save changes
        </button>
      </form>
      <NextStep href="/applications" label="Your applications" />
    </>
  );
}
