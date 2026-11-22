import "server-only";
import { NextResponse } from "next/server";
import { appConfig } from "../app";
import { getSessionSecret } from "../auth/crypto";
import { getCurrentSession } from "../auth/current";
import { verifyCsrf } from "../auth/session";
import type { AppDb } from "../db/types";
import { getDb } from "../db/server";
import { isSameOrigin, readBody, wantsHtml } from "../http";
import { JOURNEY_ERROR_STATUS, JourneyError } from "./service";

export interface ActionContext {
  db: AppDb;
  userId: string;
  sessionId: string;
  body: Record<string, string>;
  formData: FormData | null;
}

export interface ActionResult {
  redirect?: string;
  json?: unknown;
}

const MAX_MULTIPART_BYTES = 3 * 1024 * 1024;

// The single entry point for every journey action (web forms and API callers).
// Order: same origin, signed-in session that may act, CSRF, body, then the action.
// Phase 2 inserts hitlGuard here, before `run`, so no route can skip it (control C1).
export async function journeyAction(
  request: Request,
  opts: {
    action: string;
    run: (ctx: ActionContext) => Promise<ActionResult>;
    // Where a form is sent back to on error, with ?error=<code>.
    errorPath: string;
  },
) {
  const cfg = appConfig();
  const html = wantsHtml(request);
  const back = (code: string) => {
    const url = new URL(opts.errorPath, cfg.appOrigin);
    url.searchParams.set("error", code);
    return NextResponse.redirect(url, 303);
  };

  if (!isSameOrigin(request, cfg.appOrigin)) {
    return NextResponse.json({ error: "bad_request" }, { status: 403 });
  }
  const current = await getCurrentSession();
  if (!current) {
    return html
      ? NextResponse.redirect(new URL("/login", cfg.appOrigin), 303)
      : NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (current.session.approvalOnly) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: Record<string, string> = {};
  let formData: FormData | null = null;
  try {
    if ((request.headers.get("content-type") ?? "").includes("multipart/form-data")) {
      const length = Number(request.headers.get("content-length") ?? 0);
      if (length > MAX_MULTIPART_BYTES)
        return html
          ? back("too_large")
          : NextResponse.json({ error: "too_large" }, { status: 413 });
      formData = await request.formData();
      for (const [k, v] of formData.entries()) if (typeof v === "string") body[k] = v;
    } else {
      body = await readBody(request);
    }
  } catch {
    return html
      ? back("invalid_input")
      : NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }

  const csrf = request.headers.get("x-csrf-token") ?? body.csrf;
  if (!verifyCsrf(current.session.id, csrf, getSessionSecret())) {
    return NextResponse.json({ error: "csrf" }, { status: 403 });
  }
  delete body.csrf;

  try {
    const result = await opts.run({
      db: getDb(),
      userId: current.user.id,
      sessionId: current.session.id,
      body,
      formData,
    });
    if (html)
      return NextResponse.redirect(new URL(result.redirect ?? "/applications", cfg.appOrigin), 303);
    return NextResponse.json(result.json ?? { ok: true });
  } catch (err) {
    if (err instanceof JourneyError) {
      return html
        ? back(err.code)
        : NextResponse.json(
            { error: err.code, message: err.message },
            { status: JOURNEY_ERROR_STATUS[err.code] },
          );
    }
    throw err;
  }
}

// Read-only JSON endpoints: signed-in session, no CSRF needed for GET.
export async function journeyRead<T>(run: (ctx: { db: AppDb; userId: string }) => Promise<T>) {
  const current = await getCurrentSession();
  if (!current || current.session.approvalOnly) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  try {
    return NextResponse.json(await run({ db: getDb(), userId: current.user.id }));
  } catch (err) {
    if (err instanceof JourneyError) {
      return NextResponse.json({ error: err.code }, { status: JOURNEY_ERROR_STATUS[err.code] });
    }
    throw err;
  }
}
