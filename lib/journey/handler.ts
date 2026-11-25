import "server-only";
import { NextResponse } from "next/server";
import { appConfig } from "../app";
import { getSessionSecret } from "../auth/crypto";
import { getCurrentSession } from "../auth/current";
import { verifyCsrf } from "../auth/session";
import type { AppDb } from "../db/types";
import { getDb } from "../db/server";
import { gateStatus, handoffMode, poppyOn } from "../flags";
import { TICKET_USER_LIMIT, hitlGuard, type GuardResult } from "../hitl/guard";
import {
  STEP_UP_HEADER,
  continueUrl,
  deniedBody,
  gatedBody,
  ticketInvalidBody,
} from "../hitl/response";
import { isSameOrigin, readBody, wantsHtml } from "../http";
import {
  approvalFromHeader,
  declaresOperations,
  declinedBody,
  operationFor,
  performedBody,
} from "../poppy/operations";
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
    // The application the action targets, part of the approval binding (FR17).
    resourceId?: string | null;
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

  const db = getDb();
  // Poppy Operations format (FR43): only with POPPY=on, for API requests that
  // declare the extension. Everyone else gets the responses below unchanged.
  const poppy = !html && poppyOn() && declaresOperations(request);
  let finish: ((o: "executed" | "error", reason?: string) => Promise<void>) | undefined;
  try {
    // The guard decides before anything runs (control C1). Only an `ok` lets the
    // action through; gated, denied and invalid-ticket results return here.
    const guard = await hitlGuard({
      db,
      request,
      route: html ? "web" : "api",
      userId: current.user.id,
      session: current.session,
      action: opts.action,
      resourceId: opts.resourceId ?? null,
      body,
      secret: getSessionSecret(),
      mode: cfg.hitlMode,
      ttlSeconds: cfg.ticketTtlSeconds,
      poppyApproval: poppy ? approvalFromHeader(request) : null,
    });
    if (guard.kind !== "ok") return guardResponse(guard, opts, html, cfg.appOrigin, back, poppy);
    finish = guard.finish;

    const result = await opts.run({
      db,
      userId: current.user.id,
      sessionId: current.session.id,
      body,
      formData,
    });
    await finish("executed");
    if (html)
      return NextResponse.redirect(new URL(result.redirect ?? "/applications", cfg.appOrigin), 303);
    return NextResponse.json(result.json ?? { ok: true });
  } catch (err) {
    await finish?.("error", err instanceof JourneyError ? err.code : "exception");
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

function guardResponse(
  guard: Exclude<GuardResult, { kind: "ok" }>,
  opts: { action: string; errorPath: string },
  html: boolean,
  appOrigin: string,
  back: (code: string) => NextResponse,
  poppy = false,
) {
  switch (guard.kind) {
    case "gated": {
      if (html) {
        // Redirect mode sends the browser to the approval page; the URL is built
        // here from APP_ORIGIN and the ticket ID only (FR26, T7).
        if (handoffMode() === "redirect") {
          return NextResponse.redirect(continueUrl(appOrigin, guard.ticket.id), 303);
        }
        // Otherwise the step page shows the handoff panel for this ticket.
        const url = new URL(opts.errorPath, appOrigin);
        url.searchParams.set("ticket", guard.ticket.id);
        return NextResponse.redirect(url, 303);
      }
      if (poppy) {
        // Poppy: 403 approval_required with the operation, plus our own fields.
        return NextResponse.json(
          {
            error: "approval_required",
            operation: operationFor(guard.ticket, appOrigin),
            ...gatedBody(guard.ticket, appOrigin),
          },
          { status: 403 },
        );
      }
      return NextResponse.json(gatedBody(guard.ticket, appOrigin), {
        status: gateStatus(),
        headers: { "WWW-Authenticate": STEP_UP_HEADER },
      });
    }
    case "approval_declined":
      return NextResponse.json(declinedBody(guard.ticket, appOrigin), { status: 403 });
    case "already_performed":
      // At most once (Poppy Operations 6): a resend says it was done, or that it
      // is still running; it never repeats the action.
      if (guard.status === "performed") return NextResponse.json(performedBody(guard.ticket));
      if (guard.status === "performing") {
        return NextResponse.json(
          { error: "performing", operation_id: guard.ticket.id },
          { status: 503, headers: { "Retry-After": "2" } },
        );
      }
      return NextResponse.json(ticketInvalidBody(opts.action, guard.ticket.id, "consumed"), {
        status: 409,
      });
    case "denied":
      if (html)
        return back(guard.reason === "rate_limited" ? "rate_limited" : `denied_${opts.action}`);
      // The guard doesn't report when the lock ends; ticket locks last lockSec (60 s).
      return NextResponse.json(deniedBody(opts.action, guard.reason), {
        status: guard.reason === "rate_limited" ? 429 : 403,
        headers:
          guard.reason === "rate_limited"
            ? { "Retry-After": String(TICKET_USER_LIMIT.lockSec) }
            : undefined,
      });
    case "ticket_invalid":
      if (html) return back(`ticket_${guard.reason}`);
      return NextResponse.json(ticketInvalidBody(opts.action, guard.ticketId, guard.reason), {
        status: 409,
      });
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
