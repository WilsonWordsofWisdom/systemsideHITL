import "server-only";
import { appConfig } from "../app";
import { clientIp, ipHash, isSameOrigin } from "../http";
import { getSessionSecret } from "./crypto";
import { getCurrentSession } from "./current";
import { verifyCsrf } from "./session";

// Shared checks for signed-in JSON routes: same origin, live session that may
// act on the journey, and a valid CSRF header (control S2).
export async function requireJsonSession(request: Request) {
  if (!isSameOrigin(request, appConfig().appOrigin))
    return { error: "bad_request", status: 403 } as const;
  const current = await getCurrentSession();
  if (!current) return { error: "unauthenticated", status: 401 } as const;
  if (!verifyCsrf(current.session.id, request.headers.get("x-csrf-token"), getSessionSecret())) {
    return { error: "csrf", status: 403 } as const;
  }
  return { current } as const;
}

export function requestMeta(request: Request) {
  return {
    userAgent: request.headers.get("user-agent")?.slice(0, 300) ?? null,
    ipHash: ipHash(clientIp(request), getSessionSecret()),
  };
}
