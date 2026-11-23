import Link from "next/link";
import { CsrfField, ErrorNotice, JourneyLayout, NextStep, Notice, btn } from "@/components/journey";
import { loadOwnApplication } from "@/lib/journey/page";
import { FEE } from "@/lib/journey/service";

// Step 7: pay the mock fee. No real payment is taken.
export default async function PayPage({ params, searchParams }: PageProps<"/apply/[id]/pay">) {
  const { id } = await params;
  const query = await searchParams;
  const { app, csrf } = await loadOwnApplication(id);

  return (
    <JourneyLayout step="pay">
      <h1 className="mb-4 text-[28px] leading-9">Pay the fee</h1>
      <ErrorNotice code={query.error} />
      {app.status === "draft" && (
        <Notice tone="info" title="Submit the application first">
          <Link href={`/apply/${app.id}/declare`} className="underline">
            Go to the declaration
          </Link>
        </Notice>
      )}
      {app.status === "paid" && <Notice tone="success" title="The fee has been paid" />}
      {app.status === "submitted" && (
        <form action={`/api/applications/${app.id}/pay`} method="post" className="space-y-4">
          <CsrfField csrf={csrf} />
          <p>
            The permit fee for <strong>{app.title}</strong> is ${FEE.amount}. This is a mock
            payment: no card is charged.
          </p>
          <button type="submit" className={btn.filled}>
            Pay ${FEE.amount} (mock payment)
          </button>
        </form>
      )}
      <NextStep href={`/applications/${app.id}`} label="Application summary" />
    </JourneyLayout>
  );
}
