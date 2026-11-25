import { NextResponse } from "next/server";
import { appConfig } from "@/lib/app";
import { getSessionSecret } from "@/lib/auth/crypto";
import { SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth/current";
import { createSession } from "@/lib/auth/session";
import { runIdFromRequest } from "@/lib/console/run";
import { getDb } from "@/lib/db/server";
import { poppyOn } from "@/lib/flags";
import { classifyActor, getClassifierConfig, loginClassification } from "@/lib/hitl/classifier";
import { clientContextHash, loginClassifierInput, recordLoginRisk } from "@/lib/hitl/inputs";
import { clientIp, ipHash, isSameOrigin, readBody } from "@/lib/http";
import { logEvent } from "@/lib/log";
import { JOIN_COOKIE, JOIN_TTL_SECONDS, completeJoin, startJoin } from "@/lib/poppy/join";
import { notFound } from "@/lib/poppy/version";
import { lockedUntil, recordFailure, retryAfter, type LimitRule } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

// Join pages per IP hash: each one writes a code row.
const JOIN_LIMIT: LimitRule = { max: 60, windowSec: 60, lockSec: 60 };

const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; form-action 'self'; frame-ancestors 'none'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
};

const page = (body: string, status = 200) =>
  new NextResponse(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Connect this browser - DemoGov Permits</title></head><body>${body}</body></html>`,
    { status, headers: PAGE_HEADERS },
  );

const cookieOptions = {
  path: "/",
  secure: true,
  httpOnly: true,
  sameSite: "strict" as const,
};

// Step 1 (Poppy 6): a page with a one-time code. Loading it starts, ends or changes
// no session and no other cookie.
export async function GET(request: Request) {
  if (!poppyOn()) return notFound();
  const db = getDb();
  const now = new Date();
  const key = `poppy:join:${ipHash(clientIp(request), getSessionSecret())}`;
  const until = await lockedUntil(db, key, now);
  if (until) {
    return new NextResponse("Too many requests", {
      status: 429,
      headers: { "Retry-After": retryAfter(until, now, JOIN_LIMIT.lockSec) },
    });
  }
  await recordFailure(db, key, JOIN_LIMIT, now);
  const { code, cookie } = await startJoin(db, now);
  const response = page(
    `<main><h1>Connect this browser</h1><p>This browser is being connected to an assistant's session on DemoGov Permits.</p><form method="post" action="/poppy/join"><input type="hidden" name="code" value="${code}"><button type="submit">Continue</button></form></main>`,
  );
  response.cookies.set(JOIN_COOKIE, cookie, { ...cookieOptions, maxAge: JOIN_TTL_SECONDS });
  return response;
}

// Step 3: the browser submits the code. A signed-in join starts a website session
// for the account, marked as a Poppy join (a declared agent); a signed-out join
// keeps whatever login the browser has.
export async function POST(request: Request) {
  if (!poppyOn()) return notFound();
  const cfg = appConfig();
  const failure = () =>
    page(
      "<main><h1>This browser could not be connected</h1><p>The connection code has expired or was already used. The assistant can start again.</p></main>",
      400,
    );
  if (!isSameOrigin(request, cfg.appOrigin)) return failure();
  const body = await readBody(request).catch(() => ({}) as Record<string, string>);
  const cookie = /(?:^|;\s*)__Host-poppy_join=([^;]+)/.exec(
    request.headers.get("cookie") ?? "",
  )?.[1];
  const db = getDb();
  const now = new Date();
  const secret = getSessionSecret();
  const row =
    typeof body.code === "string" && body.code.length <= 200
      ? await completeJoin(db, body.code, cookie, now)
      : null;
  if (!row) return failure();

  let response: NextResponse;
  if (row.userId) {
    const actor = classifyActor(
      loginClassifierInput(request, {
        signinMethod: "poppy_join",
        selfDeclared: false,
        snapshot: null,
        protocolAgent: { source: "poppy_join", agent: row.clientId! },
      }),
      getClassifierConfig(),
    );
    const { token, session } = await createSession(
      db,
      {
        userId: row.userId,
        signinMethod: "poppy_join",
        declaredAgent: true,
        loginActorClass: actor.class,
        loginSignals: {
          poppy: { clientId: row.clientId, sid: row.sid, codeId: row.codeId },
          classification: loginClassification(actor),
        },
        clientCtxHash: clientContextHash(request, secret),
        runId: runIdFromRequest(request),
      },
      now,
    );
    await recordLoginRisk(db, session.id, actor, now);
    response = NextResponse.redirect(new URL("/applications", cfg.appOrigin), 303);
    response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(cfg.appOrigin));
  } else {
    response = NextResponse.redirect(new URL("/", cfg.appOrigin), 303);
  }
  response.cookies.set(JOIN_COOKIE, "", { ...cookieOptions, maxAge: 0 });
  await logEvent(db, {
    route: "web",
    method: "POST",
    pathOrTool: "poppy_join",
    userId: row.userId,
    runId: runIdFromRequest(request),
    outcome: "executed",
    reason: row.userId ? "browser_joined_signed_in" : "browser_joined_signed_out",
    actorSignals: { poppy: { clientId: row.clientId, sid: row.sid } },
    userAgent: (request.headers.get("user-agent") ?? "").slice(0, 300),
    ipHash: ipHash(clientIp(request), secret),
  });
  return response;
}
