import "server-only";
import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { users } from "../db/schema";
import { getDb } from "../db/server";
import { getSessionSecret } from "./crypto";
import { ABSOLUTE_LIFETIME_MS, csrfTokenFor, validateSession } from "./session";

export const SESSION_COOKIE = "dg_session";

export function sessionCookieOptions(appOrigin: string) {
  return {
    httpOnly: true,
    secure: appOrigin.startsWith("https://"),
    sameSite: "lax" as const,
    path: "/",
    maxAge: ABSOLUTE_LIFETIME_MS / 1000,
  };
}

// The signed-in session and user for this request, or null. Cached per request
// so the layout and page share one database read.
export const getCurrentSession = cache(async () =>
  sessionFor((await cookies()).get(SESSION_COOKIE)?.value),
);

// Approval-only sessions use their own cookie, so signing in on /approve never
// replaces or ends the main session in the same browser (control W11, T9).
export const APPROVAL_COOKIE = "dg_approval";

async function sessionFor(token: string | undefined) {
  if (!token) return null;
  const db = getDb();
  const session = await validateSession(db, token);
  if (!session) return null;
  const [user] = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);
  if (!user) return null;
  return { session, user, csrf: csrfTokenFor(session.id, getSessionSecret()) };
}

// Who is approving: an approval-only session if one exists, else the main
// session. The approval itself still needs a UV passkey assertion (FR20).
export const getApproverSession = cache(async () => {
  const jar = await cookies();
  const approval = await sessionFor(jar.get(APPROVAL_COOKIE)?.value);
  if (approval?.session.approvalOnly) return { ...approval, kind: "approval" as const };
  const main = await getCurrentSession();
  return main ? { ...main, kind: "main" as const } : null;
});

// For journey pages: approval-only sessions cannot act on the journey (W11).
export async function requireSession() {
  const current = await getCurrentSession();
  if (!current || current.session.approvalOnly) redirect("/login");
  return current;
}
