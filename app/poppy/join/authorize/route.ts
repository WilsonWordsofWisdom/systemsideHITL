import { appConfig } from "@/lib/app";
import { getSessionSecret } from "@/lib/auth/crypto";
import { getDb } from "@/lib/db/server";
import { poppyOn } from "@/lib/flags";
import { logEvent } from "@/lib/log";
import { verifyAccessToken } from "@/lib/oauth/grants";
import { oauthUrls } from "@/lib/oauth/metadata";
import { BROWSER_SIGN_IN } from "@/lib/oauth/scopes";
import { authorizeJoin } from "@/lib/poppy/join";
import { sessionError, verifyPoppySession } from "@/lib/poppy/session";
import { notFound, poppyError, versionProblem } from "@/lib/poppy/version";

// Step 2 of browser join (Poppy 6): the agent authorises the code with its Session
// header, and with a token carrying poppy:browser-sign-in to sign the browser in.
// 204 on success; 400 invalid_request for an unknown, expired or used code.
export async function POST(request: Request) {
  if (!poppyOn()) return notFound();
  const problem = versionProblem(request);
  if (problem) return problem;
  const origin = appConfig().appOrigin;
  const db = getDb();
  const secret = getSessionSecret();

  const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]?.trim();
  // Only a domain-wide token (a sign-in without `resource`) is accepted here.
  const token = bearer
    ? await verifyAccessToken(db, bearer, {
        secret,
        issuer: oauthUrls(origin).issuer,
        resource: origin,
      })
    : null;
  if (bearer && !token) {
    return poppyError("invalid_token", 401, { "WWW-Authenticate": 'Bearer error="invalid_token"' });
  }
  if (token && !token.scope.split(" ").includes(BROWSER_SIGN_IN)) {
    return poppyError("insufficient_scope", 403, {
      "WWW-Authenticate": `Bearer error="insufficient_scope", scope="${BROWSER_SIGN_IN}"`,
    });
  }
  const check = await verifyPoppySession(db, request, {
    origin,
    token:
      token && bearer ? { value: bearer, clientId: token.clientId, userId: token.userId } : null,
  });
  if (!check) return poppyError("invalid_session", 400);
  if (!check.ok) return sessionError(check);

  const body = (await request.json().catch(() => null)) as { code?: unknown } | null;
  const code = body?.code;
  const ok =
    typeof code === "string" &&
    code.length <= 200 &&
    (await authorizeJoin(db, code, {
      clientId: check.session.clientId,
      sid: check.session.sid,
      userId: token?.userId ?? null,
      codeId: token?.codeId ?? null,
    }));
  await logEvent(db, {
    route: "api",
    method: "POST",
    pathOrTool: "poppy_join_authorize",
    userId: token?.userId ?? null,
    outcome: ok ? "executed" : "blocked",
    reason: ok
      ? token
        ? "join_authorized_signed_in"
        : "join_authorized_signed_out"
      : "invalid_code",
    actorSignals: { poppy: { clientId: check.session.clientId, sid: check.session.sid } },
    userAgent: (request.headers.get("user-agent") ?? "").slice(0, 300),
  });
  if (!ok) return poppyError("invalid_request", 400);
  return new Response(null, { status: 204 });
}
