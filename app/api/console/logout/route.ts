import { NextResponse } from "next/server";
import { appConfig } from "@/lib/app";
import { ADMIN_COOKIE } from "@/lib/console/admin";
import { requireAdminRequest } from "@/lib/console/current";
import { readBody } from "@/lib/http";

// Console sign-out: clears the admin cookie.
export async function POST(request: Request) {
  const body = await readBody(request).catch(() => ({}) as Record<string, string>);
  const refused = await requireAdminRequest(request, body.csrf);
  if (refused) return refused;
  const response = NextResponse.redirect(new URL("/console", appConfig().appOrigin), 303);
  response.cookies.set(ADMIN_COOKIE, "", { path: "/", maxAge: 0 });
  return response;
}
