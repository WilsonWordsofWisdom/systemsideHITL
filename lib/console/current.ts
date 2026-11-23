import "server-only";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { appConfig } from "../app";
import { getSessionSecret, safeEqual } from "../auth/crypto";
import { isSameOrigin } from "../http";
import { ADMIN_COOKIE, adminCsrf, getAdminSecret, verifyAdminToken } from "./admin";

// The console admin for this request, or null (also null when ADMIN_SECRET is unset).
export async function getAdmin() {
  const adminSecret = getAdminSecret();
  if (!adminSecret) return null;
  const token = (await cookies()).get(ADMIN_COOKIE)?.value;
  const key = getSessionSecret();
  if (!verifyAdminToken(token, key, adminSecret)) return null;
  return { csrf: adminCsrf(key, token!) };
}

// For console API routes: same origin, admin cookie and, for writes, the console
// CSRF token. Returns a response to send instead when a check fails.
export async function requireAdminRequest(request: Request, csrfFromBody?: string) {
  if (!isSameOrigin(request, appConfig().appOrigin)) {
    return NextResponse.json({ error: "bad_request" }, { status: 403 });
  }
  const admin = await getAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (request.method !== "GET") {
    const sent = request.headers.get("x-csrf-token") ?? csrfFromBody ?? "";
    if (!safeEqual(sent, admin.csrf)) {
      return NextResponse.json({ error: "csrf" }, { status: 403 });
    }
  }
  return null;
}
