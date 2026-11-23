import { NextResponse, type NextRequest } from "next/server";
import { RUN_COOKIE, validRunId } from "./lib/console/run";

// Run tagging (FR40): ?run=<id> on any page sets the run cookie for this browser,
// so the agent's later requests are logged against that test run. Only a short
// identifier is accepted; anything else is ignored. No authorisation happens here.
export function proxy(request: NextRequest) {
  const run = validRunId(request.nextUrl.searchParams.get("run"));
  const response = NextResponse.next();
  if (run && request.cookies.get(RUN_COOKIE)?.value !== run) {
    response.cookies.set(RUN_COOKIE, run, {
      httpOnly: true,
      secure: request.nextUrl.protocol === "https:",
      sameSite: "lax",
      path: "/",
      maxAge: 8 * 60 * 60,
    });
  }
  return response;
}

export const config = {
  // Pages only: not API routes, static files or the console itself.
  matcher: ["/((?!api|_next|console|favicon.ico|signals.js).*)"],
};
