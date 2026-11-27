import { desc, eq } from "drizzle-orm";
import { requireSession } from "@/lib/auth/current";
import { passkeys } from "@/lib/db/schema";
import { getDb } from "@/lib/db/server";
import { passkeyEnrolmentOpen } from "@/lib/flags";
import { EnrolButton } from "./enrol-button";

// Passkey setup, the approver "2FA" (FR6, FR7; design.md 4.3).
export default async function PasskeysPage() {
  const { user, csrf, session } = await requireSession();
  const rows = await getDb()
    .select({ id: passkeys.id, createdAt: passkeys.createdAt, transports: passkeys.transports })
    .from(passkeys)
    .where(eq(passkeys.userId, user.id))
    .orderBy(desc(passkeys.createdAt));
  const open = passkeyEnrolmentOpen();
  // Without a passkey sign-in, adding a passkey needs an enrolment code (gap H1).
  const needsCode = rows.length === 0 || session.signinMethod !== "passkey";
  const date = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" });

  return (
    <>
      <h1 className="mb-4 text-[28px] leading-9">Passkeys</h1>
      <p className="mb-6">
        A passkey lets you approve important steps, such as submitting a declaration or paying, with
        your fingerprint, face or device PIN. Automated assistants can&apos;t use it.
      </p>

      {!open && (
        <div
          role="status"
          className="mb-6 rounded-xl bg-info-container px-6 py-4 text-on-info-container"
        >
          <h2 className="font-medium">Adding passkeys is turned off</h2>
          <p className="text-sm">
            New passkeys can&apos;t be added during test runs. Passkeys you already have still work.
          </p>
        </div>
      )}

      <section
        aria-labelledby="your-passkeys"
        className="rounded-xl border border-outline-variant bg-white p-6"
      >
        <h2 id="your-passkeys" className="mb-2 font-medium">
          Your passkeys
        </h2>
        {rows.length === 0 ? (
          <p className="text-on-surface-variant">You haven&apos;t added a passkey yet.</p>
        ) : (
          <ul>
            {rows.map((p, i) => (
              <li
                key={p.id}
                className="flex justify-between border-b border-outline-variant py-3 last:border-0"
              >
                <span>Passkey {rows.length - i}</span>
                <span className="text-sm text-on-surface-variant">
                  Added {date.format(p.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <EnrolButton csrf={csrf} disabled={!open} needsCode={needsCode} />
    </>
  );
}
