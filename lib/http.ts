// Request helpers shared by route handlers.
import { hmacBase64Url } from "./auth/crypto";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// State-changing requests must come from APP_ORIGIN (control S2). Browsers send
// Origin on POST; Referer is the fallback. Non-browser clients without either
// are rejected for cookie-authenticated routes.
export function isSameOrigin(request: Request, appOrigin: string): boolean {
  if (!MUTATING.has(request.method)) return true;
  const origin = request.headers.get("origin");
  if (origin) return origin === appOrigin;
  const referer = request.headers.get("referer");
  if (!referer) return false;
  try {
    return new URL(referer).origin === appOrigin;
  } catch {
    return false;
  }
}

// HTML form posts get redirects; everything else gets JSON.
export function wantsHtml(request: Request): boolean {
  const type = request.headers.get("content-type") ?? "";
  return type.includes("application/x-www-form-urlencoded") || type.includes("multipart/form-data");
}

const MAX_BODY_BYTES = 16 * 1024;

export async function readBody(request: Request): Promise<Record<string, string>> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new Error("body too large");
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const parsed: unknown = text ? JSON.parse(text) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [
        k,
        typeof v === "string" ? v : JSON.stringify(v),
      ]),
    );
  }
  return Object.fromEntries(new URLSearchParams(text));
}

export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip") || "unknown";
}

// IPs are only ever stored as keyed hashes (control D4).
export function ipHash(ip: string, secret: string): string {
  return hmacBase64Url(secret, `ip:${ip}`);
}
