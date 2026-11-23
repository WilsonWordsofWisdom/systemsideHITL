// Console admin access (FR39, controls L2, L3). Separate from user sign-in: an
// env-secret login sets its own signed cookie, so nothing an agent can reach
// through the demo account opens the console. Functions take `now` for tests.
import { hmacBase64Url, safeEqual, sha256Hex } from "../auth/crypto";
import type { LimitRule } from "../ratelimit";

export const ADMIN_COOKIE = "dg_admin";
export const ADMIN_TTL_MS = 8 * 60 * 60 * 1000;
// J11: 5 wrong secrets within a minute lock the console login for 10 minutes.
export const ADMIN_LOGIN_LIMIT: LimitRule = { max: 5, windowSec: 60, lockSec: 600 };
const MIN_ADMIN_SECRET = 16;

// The configured admin secret, or null when the console is not set up.
export function getAdminSecret(env: Record<string, string | undefined> = process.env) {
  const value = env.ADMIN_SECRET?.trim();
  return value && value.length >= MIN_ADMIN_SECRET ? value : null;
}

export function adminSecretMatches(input: string, adminSecret: string) {
  // Compare fixed-length digests so the length of the secret isn't leaked.
  return safeEqual(sha256Hex(input), sha256Hex(adminSecret));
}

// The cookie is "<expiry>.<mac>". The MAC covers the expiry and a fingerprint of
// the admin secret, so changing ADMIN_SECRET signs every admin out.
function mac(signingKey: string, adminSecret: string, expiry: number) {
  return hmacBase64Url(signingKey, `admin:${expiry}:${sha256Hex(adminSecret)}`);
}

export function makeAdminToken(signingKey: string, adminSecret: string, now = new Date()) {
  const expiry = now.getTime() + ADMIN_TTL_MS;
  return `${expiry}.${mac(signingKey, adminSecret, expiry)}`;
}

export function verifyAdminToken(
  token: string | undefined | null,
  signingKey: string,
  adminSecret: string,
  now = new Date(),
) {
  if (!token) return false;
  const [expiryText, signature] = token.split(".");
  const expiry = Number(expiryText);
  if (!Number.isSafeInteger(expiry) || !signature || expiry <= now.getTime()) return false;
  return safeEqual(signature, mac(signingKey, adminSecret, expiry));
}

// CSRF token for console forms, bound to the admin cookie.
export function adminCsrf(signingKey: string, token: string) {
  return hmacBase64Url(signingKey, `admin-csrf:${token}`);
}
