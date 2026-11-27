// Console display pieces (design.md 2.1 status chips, 4.8). Colour is never the
// only signal: every chip carries its word.
const CLASS_CHIP: Record<string, { text: string; cls: string }> = {
  human: { text: "human", cls: "bg-success-container text-on-success-container" },
  declared_agent: { text: "declared", cls: "bg-info-container text-on-info-container" },
  suspected_agent: { text: "suspected", cls: "bg-[#FFDDB3] text-[#2B1700]" },
  unknown: { text: "unknown", cls: "bg-[#E1E4E4] text-[#2B3133]" },
};

const DECISION_CHIP: Record<string, string> = {
  allow: "bg-success-container text-on-success-container",
  gate: "bg-warning-container text-on-warning-container",
  deny: "bg-error-container text-on-error-container",
};

const chip = "inline-block rounded-lg px-2 py-0.5 text-xs font-medium";

export function ClassChip({ value }: { value: string | null }) {
  if (!value) return <span className="text-on-surface-variant">–</span>;
  const c = CLASS_CHIP[value] ?? { text: value, cls: "bg-[#E1E4E4] text-[#2B3133]" };
  return <span className={`${chip} ${c.cls}`}>{c.text}</span>;
}

export function DecisionChip({ value }: { value: string | null }) {
  if (!value) return <span className="text-on-surface-variant">–</span>;
  return <span className={`${chip} ${DECISION_CHIP[value] ?? ""}`}>{value}</span>;
}

// "Chrome 140", "HeadlessChrome 140", "python-requests" and so on.
export function shortAgent(ua: string | null): string {
  if (!ua) return "–";
  const known = ua.match(
    /(HeadlessChrome|Edg|Chrome|Firefox|Safari|python-requests|python-httpx|curl|node-fetch|undici|axios|Playwright)\/?(\d+)?/,
  );
  if (!known) return ua.slice(0, 24);
  const name = known[1] === "Edg" ? "Edge" : known[1];
  // Safari's UA also names Chrome-based browsers; prefer the earlier, more specific match.
  return known[2] ? `${name} ${known[2]}` : name;
}

export const shortId = (id: string | null, n = 8) => (id ? `${id.slice(0, n)}…` : "–");

export function ObserveBanner({ until }: { until: Date }) {
  return (
    <p
      role="status"
      className="mb-4 rounded-xl bg-warning-container px-6 py-3 text-on-warning-container"
    >
      Observe mode: decisions are logged but nothing is blocked. Enforcement resumes by itself at{" "}
      {until.toISOString().replace("T", " ").slice(0, 16)} UTC.
    </p>
  );
}
