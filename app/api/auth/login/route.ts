import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { appConfig } from "@/lib/app";
import { getSessionSecret, sha256Hex } from "@/lib/auth/crypto";
import { SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth/current";
import { verifyPassword } from "@/lib/auth/password";
import { createSession, revokeSession } from "@/lib/auth/session";
import { users } from "@/lib/db/schema";
import { getDb } from "@/lib/db/server";
import { selfDeclareUiOn } from "@/lib/flags";
import { clientIp, ipHash, isSameOrigin, readBody, wantsHtml } from "@/lib/http";
import {
  LOGIN_EMAIL_LIMIT,
  LOGIN_IP_LIMIT,
  clearFailures,
  lockedUntil,
  recordFailure,
} from "@/lib/ratelimit";
import { classifyActor, getClassifierConfig, loginClassification } from "@/lib/hitl/classifier";
import { clientContextHash, loginClassifierInput, recordLoginRisk } from "@/lib/hitl/inputs";
import { runIdFromRequest } from "@/lib/console/run";
import { safeNextPath } from "@/lib/oauth/authorize";
import { headerFacts, parseSignals } from "@/lib/signals";

const LoginForm = z.object({
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  password: z.string().min(1).max(200),
  self_declare: z.string().optional(),
  signals: z.string().max(4000).optional(),
  next: z.string().max(4096).optional(),
});

type ErrorCode = "invalid" | "locked" | "bad_request";
const STATUS: Record<ErrorCode, number> = { invalid: 401, locked: 429, bad_request: 400 };

// Password sign-in (FR6). Errors never say whether the account exists.
export async function POST(request: Request) {
  const cfg = appConfig();
  const html = wantsHtml(request);
  const fail = (code: ErrorCode) =>
    html
      ? NextResponse.redirect(new URL(`/login?error=${code}`, cfg.appOrigin), 303)
      : NextResponse.json({ error: code }, { status: STATUS[code] });

  if (!isSameOrigin(request, cfg.appOrigin)) return fail("bad_request");
  let body: Record<string, string>;
  try {
    body = await readBody(request);
  } catch {
    return fail("bad_request");
  }
  const parsed = LoginForm.safeParse(body);
  if (!parsed.success) return fail("invalid");
  const { email, password } = parsed.data;

  const db = getDb();
  const secret = getSessionSecret();
  const now = new Date();
  const ip = ipHash(clientIp(request), secret);
  const emailKey = `login:email:${email}`;
  const ipKey = `login:ip:${ip}`;

  if ((await lockedUntil(db, emailKey, now)) || (await lockedUntil(db, ipKey, now))) {
    return fail("locked");
  }

  const [user] = await db
    .select({ id: users.id, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (!(await verifyPassword(user?.passwordHash, password)) || !user) {
    const emailLocked = await recordFailure(db, emailKey, LOGIN_EMAIL_LIMIT, now);
    const ipLocked = await recordFailure(db, ipKey, LOGIN_IP_LIMIT, now);
    return fail(emailLocked || ipLocked ? "locked" : "invalid");
  }
  await clearFailures(db, emailKey);

  // Rotate: a session that existed before this sign-in is ended (control S1).
  const previous = request.headers
    .get("cookie")
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  if (previous) await revokeSession(db, sha256Hex(previous), "rotated", now);

  const selfDeclared = selfDeclareUiOn() && parsed.data.self_declare === "on";
  const userAgent = request.headers.get("user-agent") ?? "";
  const client = parseSignals(parsed.data.signals);
  // Same classifier as every request (architecture 4.3); stored as the login class.
  const actor = classifyActor(
    loginClassifierInput(request, { signinMethod: "password", selfDeclared, snapshot: client }),
    getClassifierConfig(),
  );
  const { token, session } = await createSession(
    db,
    {
      userId: user.id,
      signinMethod: "password",
      declaredAgent: selfDeclared,
      loginActorClass: actor.class,
      loginSignals: {
        selfDeclared,
        client,
        headers: headerFacts(request),
        userAgent: userAgent.slice(0, 300),
        classification: loginClassification(actor),
      },
      clientCtxHash: clientContextHash(request, secret),
      runId: runIdFromRequest(request),
    },
    now,
  );
  await recordLoginRisk(db, session.id, actor, now);

  const response = html
    ? NextResponse.redirect(
        new URL(safeNextPath(parsed.data.next) ?? "/applications", cfg.appOrigin),
        303,
      )
    : NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(cfg.appOrigin));
  return response;
}
