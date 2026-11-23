// Validation for behaviour signals sent by public/signals.js (FR9, FR11).
// The payload is untrusted: only small flat records of numbers, booleans or null
// are kept.
import { z } from "zod";

const value = z.union([z.number().finite(), z.boolean(), z.null()]);
const nested = z.record(z.string().max(40), value);

export const SignalsPayload = z
  .record(z.string().max(40), z.union([value, nested]))
  .refine((r) => Object.keys(r).length <= 40, "too many fields");

export type Signals = z.infer<typeof SignalsPayload>;

export function parseSignals(raw: string | undefined | null): Signals | null {
  if (!raw || raw.length > 4000) return null;
  try {
    const result = SignalsPayload.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

// Request-header facts recorded alongside client signals (tier D heuristics).
export function headerFacts(request: Request) {
  const h = request.headers;
  return {
    hasAcceptLanguage: h.has("accept-language"),
    hasSecChUa: h.has("sec-ch-ua"),
    secFetchSite: h.get("sec-fetch-site"),
    secFetchMode: h.get("sec-fetch-mode"),
    xAgent: h.get("x-agent")?.slice(0, 80) ?? null,
  };
}
