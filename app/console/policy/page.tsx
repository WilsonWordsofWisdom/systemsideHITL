import { readFileSync } from "node:fs";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getAdmin } from "@/lib/console/current";
import { getClassifierConfig } from "@/lib/hitl/classifier";
import { POLICY_PATH, getPolicy } from "@/lib/hitl/policy";

// The loaded policy, read-only (spec section 7, J11): there is no way to change it
// from the console; it changes only through a reviewed commit.
export default async function PolicyPage() {
  if (!(await getAdmin())) redirect("/console");
  // Parse first, so a broken file shows as an error here rather than as text.
  const policy = getPolicy();
  const source = readFileSync(POLICY_PATH, "utf8");
  const weights = getClassifierConfig();
  return (
    <>
      <div className="mb-4 flex items-center gap-4">
        <h1 className="text-[28px] leading-9">Policy</h1>
        <Link href="/console" className="text-sm text-primary underline-offset-4 hover:underline">
          Back to requests
        </Link>
      </div>
      <p className="mb-4 text-on-surface-variant">
        Policy version {policy.data.version} and classifier weights {weights.version}, loaded at
        start-up. Read-only: changes are made in the repository and reviewed.
      </p>
      <h2 className="mb-2 text-lg font-medium">policy/hitl-policy.yaml</h2>
      <pre className="overflow-x-auto rounded-xl border border-outline-variant bg-white p-4 text-xs">
        {source}
      </pre>
    </>
  );
}
