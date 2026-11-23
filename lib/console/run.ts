// Test-run tagging (FR40). A tester starts an agent at any URL with ?run=<id>; the
// proxy stores it in a cookie, sign-in copies it to the session, and every logged
// request carries it so the console can filter by run.
export const RUN_COOKIE = "dg_run";
export const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

export function validRunId(value: string | null | undefined): string | null {
  return value && RUN_ID_PATTERN.test(value) ? value : null;
}

// The run named in the request's cookie, if any.
export function runIdFromRequest(request: Request): string | null {
  const cookie = request.headers
    .get("cookie")
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${RUN_COOKIE}=`))
    ?.slice(RUN_COOKIE.length + 1);
  return validRunId(cookie ? decodeURIComponent(cookie) : null);
}
