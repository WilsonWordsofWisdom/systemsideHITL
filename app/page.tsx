import Link from "next/link";
import { agentHintsOn } from "@/lib/flags";

// Landing page (FR5): neutral purpose statement and journey overview. No text is
// addressed to models; the approval note appears only with AGENT_HINTS=on.
const STEPS = [
  "Sign in",
  "Check your past applications",
  "Fill in your event details",
  "Add a supporting document",
  "Review your answers",
  "Submit your declaration",
  "Pay the $50 fee",
];

export default function Home() {
  return (
    <>
      <h1 className="mb-4 text-[32px] leading-10">Apply for a Community Event Permit</h1>
      <p>
        DemoGov Permits is a fictional permit service built to test how websites work with people
        and the assistants acting for them. You can apply for a permit, track past applications and
        pay a mock fee.
      </p>

      {agentHintsOn() && (
        <section
          aria-labelledby="hints-heading"
          className="mt-6 rounded-xl bg-info-container px-6 py-4 text-on-info-container"
        >
          <h2 id="hints-heading" className="mb-1 font-medium">
            Some steps need the account holder
          </h2>
          <p className="text-sm">
            Submitting a declaration, paying, deleting an application and changing recovery details
            are approved by the account holder with a passkey. Details for automated assistants:{" "}
            <a className="underline" href="/llms.txt">
              /llms.txt
            </a>{" "}
            and{" "}
            <a className="underline" href="/agents.md">
              /agents.md
            </a>
            .
          </p>
        </section>
      )}

      <section
        aria-labelledby="how-heading"
        className="mt-6 rounded-xl border border-outline-variant bg-white p-6"
      >
        <h2 id="how-heading" className="mb-2 font-medium">
          How it works
        </h2>
        <ol className="list-decimal space-y-1 pl-6">
          {STEPS.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
      </section>

      <p className="mt-6">
        <Link
          href="/login"
          className="inline-flex h-10 items-center rounded-full bg-primary px-6 text-sm font-medium text-on-primary"
        >
          Sign in to start
        </Link>
      </p>
    </>
  );
}
