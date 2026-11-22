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
export const getCurrentSession = cache(async () => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
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
});

// For journey pages: approval-only sessions cannot act on the journey (W11).
export async function requireSession() {
  const current = await getCurrentSession();
  if (!current || current.session.approvalOnly) redirect("/login");
  return current;
}
