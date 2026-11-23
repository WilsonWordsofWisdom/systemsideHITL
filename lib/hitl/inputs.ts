// Builds classifier input from a request and its session (architecture 4.7, 4.9).
import { desc, eq } from "drizzle-orm";
import { sha256Hex } from "../auth/crypto";
import { escalateRisk, type SessionRow } from "../auth/session";
import { clientSignals } from "../db/schema";
import type { AppDb } from "../db/types";
import { clientIp, ipHash } from "../http";
import type {
  BehaviourSnapshot,
  Classification,
  ClassifierConfig,
  ClassifierInput,
} from "./classifier";

const MAX_SNAPSHOTS = 20;

// The client context the session was created with: user-agent plus IP hash (A8).
export function clientContextHash(request: Request, secret: string) {
  const userAgent = request.headers.get("user-agent") ?? "";
  return sha256Hex(`${userAgent}|${ipHash(clientIp(request), secret)}`);
}

export function requestHeaderInput(request: Request) {
  const h = request.headers;
  return {
    userAgent: (h.get("user-agent") ?? "").slice(0, 300),
    xAgent: h.get("x-agent")?.slice(0, 80) ?? null,
    headers: { acceptLanguage: h.has("accept-language"), secFetchSite: h.get("sec-fetch-site") },
  };
}

export async function requestClassifierInput(opts: {
  db: AppDb;
  request: Request;
  session: SessionRow;
  route: ClassifierInput["route"];
  cfg: ClassifierConfig;
  secret: string;
  now: Date;
  // Tier A evidence verified by the caller (Web Bot Auth or the MCP token).
  protocolAgent?: ClassifierInput["protocolAgent"];
}): Promise<ClassifierInput> {
  const { db, request, session, cfg, now } = opts;
  const since = new Date(now.getTime() - cfg.window_seconds * 1000);
  const recent = await db
    .select({ payload: clientSignals.payload, ts: clientSignals.ts })
    .from(clientSignals)
    .where(eq(clientSignals.sessionId, session.id))
    .orderBy(desc(clientSignals.ts))
    .limit(MAX_SNAPSHOTS);
  const inWindow = recent.filter((r) => r.ts > since);
  const loginClient = (session.loginSignals as { client?: unknown }).client;

  return {
    route: opts.route,
    protocolAgent: opts.protocolAgent ?? null,
    selfDeclared: session.declaredAgent,
    ...requestHeaderInput(request),
    behaviour: inWindow.map((r) => r.payload as BehaviourSnapshot),
    // No signals ever posted from a page in this session, including at sign-in.
    noPriorPageView: recent.length === 0 && !loginClient,
    clientContextChanged:
      session.clientCtxHash !== null &&
      session.clientCtxHash !== clientContextHash(request, opts.secret),
    session: {
      signinMethod: session.signinMethod,
      loginActorClass: session.loginActorClass,
      riskState: session.riskState,
    },
  };
}

// Sign-in has no session yet: the snapshot from the login form is the only
// behaviour evidence, and its absence means no page view.
export function loginClassifierInput(
  request: Request,
  opts: {
    signinMethod: "password" | "passkey";
    selfDeclared: boolean;
    snapshot: BehaviourSnapshot | null;
    protocolAgent?: ClassifierInput["protocolAgent"];
  },
): ClassifierInput {
  return {
    route: "web",
    protocolAgent: opts.protocolAgent ?? null,
    selfDeclared: opts.selfDeclared,
    ...requestHeaderInput(request),
    behaviour: opts.snapshot ? [opts.snapshot] : [],
    noPriorPageView: !opts.snapshot,
    clientContextChanged: false,
    session: { signinMethod: opts.signinMethod, loginActorClass: "unknown", riskState: "clean" },
  };
}

// Agent evidence at sign-in starts the new session at agent_observed, recorded as
// a session event (architecture 4.9 layer 3). A clean sign-in stays clean.
export async function recordLoginRisk(
  db: AppDb,
  sessionId: string,
  actor: Classification,
  now: Date,
) {
  if (actor.class !== "declared_agent" && actor.class !== "suspected_agent") return;
  await escalateRisk(
    db,
    sessionId,
    "agent_observed",
    "login_agent_evidence",
    {
      class: actor.class,
      tier: actor.tier,
      score: actor.score,
      contributions: actor.contributions,
    },
    now,
  );
}
