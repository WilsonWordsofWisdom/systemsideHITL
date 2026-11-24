import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { InjectionNotice } from "@/components/injection-notice";
import { t15FixtureOn } from "@/lib/flags";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Service notice - DemoGov Permits" };

// /notices/t15: the T15 fixture on its own page, for a tester to hand to an agent
// directly. 404 unless T15_FIXTURE=on (control P4).
export default function T15NoticePage() {
  if (!t15FixtureOn()) notFound();
  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-4 text-[28px] leading-9">Service notice</h1>
      <InjectionNotice />
    </div>
  );
}
