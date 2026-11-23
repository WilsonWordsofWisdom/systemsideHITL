// Shared journey UI (design.md sections 3 and 4.4): step indicator, notices,
// buttons. Every journey page uses one h1, a step indicator and a next-step link
// so people and agents can follow the same path (FR28).
import Link from "next/link";
import type { ReactNode } from "react";

export const STEPS = [
  { key: "signin", label: "Sign in" },
  { key: "applications", label: "Applications" },
  { key: "details", label: "Details" },
  { key: "documents", label: "Documents" },
  { key: "review", label: "Review" },
  { key: "declare", label: "Declaration", gated: true },
  { key: "pay", label: "Payment", gated: true },
] as const;
export type StepKey = (typeof STEPS)[number]["key"];

export const btn = {
  filled:
    "inline-flex h-10 items-center justify-center rounded-full bg-primary px-6 text-sm font-medium text-on-primary",
  outlined:
    "inline-flex h-10 items-center justify-center rounded-full border border-outline px-6 text-sm font-medium text-primary",
  text: "inline-flex h-10 items-center px-3 text-sm font-medium text-primary underline-offset-4 hover:underline",
  danger:
    "inline-flex h-10 items-center justify-center rounded-full border border-outline px-6 text-sm font-medium text-error",
};

export function JourneyLayout({ step, children }: { step: StepKey; children: ReactNode }) {
  const index = STEPS.findIndex((s) => s.key === step);
  return (
    <div className="grid gap-8 md:grid-cols-[1fr_200px]">
      <div>
        <p className="text-sm text-on-surface-variant">
          Step {index + 1} of {STEPS.length}
        </p>
        <div className="mb-6 mt-2 h-1 rounded bg-surface-container-high" aria-hidden="true">
          <div
            className="h-1 rounded bg-primary"
            style={{ width: `${Math.round(((index + 1) / STEPS.length) * 100)}%` }}
          />
        </div>
        {children}
      </div>
      <nav aria-label="Application steps" className="order-first md:order-none">
        <ol className="space-y-2">
          {STEPS.map((s, i) => (
            <li
              key={s.key}
              aria-current={i === index ? "step" : undefined}
              className="flex items-center gap-3 text-sm"
            >
              <span
                aria-hidden="true"
                className={`grid h-7 w-7 flex-none place-items-center rounded-full text-xs font-medium ${
                  i < index
                    ? "bg-primary text-on-primary"
                    : i === index
                      ? "bg-primary-container text-on-primary-container outline outline-2 outline-primary"
                      : "bg-surface-container-high"
                }`}
              >
                {i < index ? "✓" : i + 1}
              </span>
              <span>{s.label}</span>
              {"gated" in s && s.gated && (
                <span className="ml-auto text-xs text-on-surface-variant">
                  <span aria-hidden="true">🔒</span>
                  <span className="sr-only">Needs approval</span>
                </span>
              )}
            </li>
          ))}
        </ol>
      </nav>
    </div>
  );
}

const TONES = {
  info: "bg-info-container text-on-info-container",
  success: "bg-success-container text-on-success-container",
  warn: "bg-warning-container text-on-warning-container",
  error: "bg-error-container text-on-error-container",
};

export function Notice({
  tone,
  title,
  children,
}: {
  tone: keyof typeof TONES;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`mb-6 rounded-xl px-6 py-4 ${TONES[tone]}`}
    >
      <h2 className="font-medium">{title}</h2>
      {children && <div className="text-sm">{children}</div>}
    </div>
  );
}

const ERRORS: Record<string, { title: string; body: string }> = {
  invalid_input: {
    title: "Some answers need correcting",
    body: "Check each field and try again.",
  },
  incomplete: {
    title: "Some event details are missing",
    body: "Fill in the event name, date, attendance and location before submitting.",
  },
  invalid_state: {
    title: "This step isn't available right now",
    body: "The application may already have moved on. Check its status.",
  },
  not_found: { title: "Application not found", body: "It may have been deleted." },
  too_large: { title: "That file is too large", body: "Upload a file of 2 MB or less." },
};

export function ErrorNotice({ code }: { code?: string | string[] }) {
  const key = typeof code === "string" ? code : undefined;
  const e = key ? ERRORS[key] : undefined;
  return e ? (
    <Notice tone="error" title={e.title}>
      {e.body}
    </Notice>
  ) : null;
}

export function NextStep({ href, label }: { href: string; label: string }) {
  return (
    <p className="mt-6 text-sm">
      <Link href={href} className="text-primary underline underline-offset-4">
        Next step: {label}
      </Link>
    </p>
  );
}

export function CsrfField({ csrf }: { csrf: string }) {
  return <input type="hidden" name="csrf" value={csrf} />;
}

export const fieldLabel = "mb-1 block text-xs font-medium text-on-surface-variant";
export const fieldInput = "h-14 w-full rounded border border-outline bg-white px-4";

const STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  draft: { text: "Draft", cls: "bg-surface-container-high text-on-surface" },
  submitted: { text: "Submitted", cls: "bg-info-container text-on-info-container" },
  paid: { text: "Paid", cls: "bg-success-container text-on-success-container" },
};

export function StatusChip({ status }: { status: string }) {
  const s = STATUS_LABEL[status] ?? { text: status, cls: "bg-surface-container-high" };
  return <span className={`rounded-lg px-2.5 py-0.5 text-xs font-medium ${s.cls}`}>{s.text}</span>;
}
