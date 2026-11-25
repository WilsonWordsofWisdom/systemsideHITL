// Database schema (architecture section 6, PRD section 9.3).
// Row-level security is enabled on every table with no policies, so Supabase's
// auto-generated API exposes nothing; the app connects server-side (control D3).
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const actorClass = pgEnum("actor_class", [
  "human",
  "declared_agent",
  "suspected_agent",
  "unknown",
]);
export const signinMethod = pgEnum("signin_method", [
  "password",
  "passkey",
  "oauth_mcp",
  // A Poppy agent's browser joined its Poppy session (Phase 7, FR47).
  "poppy_join",
]);
export const riskState = pgEnum("risk_state", ["clean", "agent_observed", "handover_suspected"]);
export const applicationStatus = pgEnum("application_status", [
  "draft",
  "submitted",
  "paid",
  "deleted",
]);
export const ticketState = pgEnum("ticket_state", [
  "pending",
  "approved",
  "rejected",
  "expired",
  "consumed",
]);
export const approvalMethod = pgEnum("approval_method", ["passkey", "device", "otp"]);
export const requestRoute = pgEnum("request_route", ["web", "api", "mcp"]);
export const policyDecision = pgEnum("policy_decision", ["allow", "gate", "deny"]);
export const requestOutcome = pgEnum("request_outcome", ["executed", "blocked", "gated", "error"]);

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  phone: text("phone"),
  recoveryEmail: text("recovery_email"),
  createdAt: createdAt(),
}).enableRLS();

export const passkeys = pgTable(
  "passkeys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    credentialId: text("credential_id").notNull().unique(),
    publicKey: text("public_key").notNull(),
    counter: integer("counter").notNull().default(0),
    transports: jsonb("transports").$type<string[]>().notNull().default([]),
    // Attestation data kept for the enrolment audit (control W7).
    aaguid: text("aaguid"),
    attestationFormat: text("attestation_format"),
    createdAt: createdAt(),
  },
  (t) => [index("passkeys_user_idx").on(t.userId)],
).enableRLS();

export const sessions = pgTable(
  "sessions",
  {
    // SHA-256 of the session cookie value; the raw token is never stored.
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    declaredAgent: boolean("declared_agent").notNull().default(false),
    signinMethod: signinMethod("signin_method").notNull(),
    loginSignals: jsonb("login_signals").$type<Record<string, unknown>>().notNull().default({}),
    loginActorClass: actorClass("login_actor_class").notNull().default("unknown"),
    riskState: riskState("risk_state").notNull().default("clean"),
    clientCtxHash: text("client_ctx_hash"),
    // Approval-only sessions can approve tickets but not act on the journey (control W11).
    approvalOnly: boolean("approval_only").notNull().default(false),
    // Test run the session belongs to, from ?run= on the start URL (FR40).
    runId: text("run_id"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokeReason: text("revoke_reason"),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
).enableRLS();

export const sessionEvents = pgTable(
  "session_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    // "risk_changed" or "session_revoked".
    event: text("event").notNull(),
    fromState: riskState("from_state"),
    toState: riskState("to_state"),
    trigger: text("trigger").notNull(),
    signals: jsonb("signals").$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [index("session_events_session_idx").on(t.sessionId, t.ts)],
).enableRLS();

export const applications = pgTable(
  "applications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: applicationStatus("status").notNull().default("draft"),
    title: text("title").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    documents: jsonb("documents").$type<Record<string, unknown>[]>().notNull().default([]),
    // Incremented on every edit; part of the approval's resource snapshot (FR17).
    version: integer("version").notNull().default(1),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("applications_user_idx").on(t.userId)],
).enableRLS();

export const hitlTickets = pgTable(
  "hitl_tickets",
  {
    // "hitl_" + at least 128 bits of randomness (control T4).
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    resourceId: text("resource_id"),
    // SHA-256 of canonical JSON of request body plus resource snapshot (FR17).
    payloadHash: text("payload_hash").notNull(),
    payloadPreview: jsonb("payload_preview").$type<Record<string, unknown>>().notNull(),
    requestedByActor: jsonb("requested_by_actor").$type<Record<string, unknown>>().notNull(),
    // Redemption is bound to the requesting session or MCP client (FR19).
    requestingSessionId: text("requesting_session_id"),
    requestingClientId: text("requesting_client_id"),
    state: ticketState("state").notNull().default("pending"),
    rejectReason: text("reject_reason"),
    approvalMethod: approvalMethod("approval_method"),
    approverMeta: jsonb("approver_meta").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (t) => [index("hitl_tickets_user_state_idx").on(t.userId, t.state)],
).enableRLS();

export const requestLog = pgTable(
  "request_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    route: requestRoute("route").notNull(),
    method: text("method").notNull(),
    pathOrTool: text("path_or_tool").notNull(),
    userId: uuid("user_id"),
    sessionId: text("session_id"),
    runId: text("run_id"),
    actorClass: actorClass("actor_class"),
    actorSignals: jsonb("actor_signals").$type<Record<string, unknown>>().notNull().default({}),
    policyDecision: policyDecision("policy_decision"),
    ticketId: text("ticket_id"),
    outcome: requestOutcome("outcome").notNull(),
    reason: text("reason"),
    latencyMs: integer("latency_ms"),
    userAgent: text("user_agent"),
    // IPs are stored only as hashes (control D4).
    ipHash: text("ip_hash"),
  },
  (t) => [
    index("request_log_ts_idx").on(t.ts),
    index("request_log_run_idx").on(t.runId),
    index("request_log_session_idx").on(t.sessionId),
  ],
).enableRLS();

// Failure counters for sign-in and other rate limits, kept in Postgres so they
// hold across serverless instances (control T9, S3).
export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  count: integer("count").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
}).enableRLS();

// Behaviour signals posted by signals.js after sign-in (FR11, FR13). The
// classifier reads the most recent window of these in Phase 2.
export const clientSignals = pgTable(
  "client_signals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  },
  (t) => [index("client_signals_session_idx").on(t.sessionId, t.ts)],
).enableRLS();

// WebAuthn challenges: single use, short-lived, tied to a purpose and, where
// known, a user and session (controls W1, W2). Phase 2 adds ticket approvals.
export const webauthnChallenges = pgTable(
  "webauthn_challenges",
  {
    id: text("id").primaryKey(),
    // "register" | "login" | "approve"
    purpose: text("purpose").notNull(),
    challenge: text("challenge").notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    sessionId: text("session_id"),
    // Ticket approvals only: the challenge is H(ticket_id | payload_hash | nonce),
    // recomputed from these at verify time (control W2).
    ticketId: text("ticket_id"),
    nonce: text("nonce"),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (t) => [index("webauthn_challenges_expiry_idx").on(t.expiresAt)],
).enableRLS();

// Test runs and their ground truth, set by the tester in the console (FR16,
// FR40). Test metadata only: the classifier never reads this table (A6).
export const runs = pgTable("runs", {
  id: text("id").primaryKey(),
  // Which agent (or person) really drove the run, e.g. "ChatGPT agent, web".
  agentLabel: text("agent_label"),
  // Who was really acting: agent, human or mixed (handover runs).
  actualActor: text("actual_actor"),
  notes: text("notes"),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();

// OAuth authorization codes for MCP clients (FR30, control M1). Only the SHA-256
// of the code is stored; a code is single use and short-lived, bound to the
// client, redirect URI, user, PKCE challenge and resource.
export const oauthCodes = pgTable(
  "oauth_codes",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    redirectUri: text("redirect_uri").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    scope: text("scope").notNull(),
    resource: text("resource").notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (t) => [index("oauth_codes_expiry_idx").on(t.expiresAt)],
).enableRLS();

// Access tokens issued to MCP clients, by JWT ID, so one can be revoked (for
// example when its authorization code is replayed).
export const oauthTokens = pgTable(
  "oauth_tokens",
  {
    jti: text("jti").primaryKey(),
    clientId: text("client_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeId: text("code_id"),
    scope: text("scope").notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("oauth_tokens_code_idx").on(t.codeId)],
).enableRLS();

export const mcpClients = pgTable("mcp_clients", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: text("client_id").notNull().unique(),
  name: text("name").notNull(),
  redirectUris: jsonb("redirect_uris").$type<string[]>().notNull().default([]),
  registeredAt: timestamp("registered_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();

// Refresh tokens for Poppy agents (Phase 7, FR45, control PP9). Only the SHA-256 is
// stored. `codeId` names the sign-in they descend from: rotation keeps it, and
// revoking one revokes the whole family and its access tokens.
export const oauthRefreshTokens = pgTable(
  "oauth_refresh_tokens",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeId: text("code_id").notNull(),
    scope: text("scope").notNull(),
    resource: text("resource").notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("oauth_refresh_tokens_code_idx").on(t.codeId)],
).enableRLS();

// Poppy Sessions seen here (Poppy 1.0 section 5.3, FR46): the user ID and agent ID a
// Session starts with are kept, and later Session JWTs must match them.
export const poppySessions = pgTable(
  "poppy_sessions",
  {
    clientId: text("client_id").notNull(),
    sid: text("sid").notNull(),
    sub: text("sub").notNull(),
    agentId: text("agent_id"),
    createdAt: createdAt(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.clientId, t.sid] })],
).enableRLS();

// A Poppy agent's opaque user ID for one of our accounts (FR46). Set the first time
// a Session arrives with an access token; ours is never sent to the agent.
export const poppyLinks = pgTable(
  "poppy_links",
  {
    clientId: text("client_id").notNull(),
    sub: text("sub").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.clientId, t.sub] })],
).enableRLS();

// Seen JWT IDs (Session JWTs and client assertions), kept for their acceptance
// window so a replay is refused (control PP5, PP7).
export const poppyJtis = pgTable(
  "poppy_jtis",
  {
    key: text("key").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("poppy_jtis_expiry_idx").on(t.expiresAt)],
).enableRLS();

// Browser join codes (Poppy 1.0 section 6, FR47). Only the SHA-256 of the code is
// stored; a code lasts 60 seconds and works once.
export const poppyJoinCodes = pgTable(
  "poppy_join_codes",
  {
    id: text("id").primaryKey(),
    cookieHash: text("cookie_hash").notNull(),
    clientId: text("client_id"),
    sid: text("sid"),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    codeId: text("code_id"),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    authorizedAt: timestamp("authorized_at", { withTimezone: true }),
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (t) => [index("poppy_join_codes_expiry_idx").on(t.expiresAt)],
).enableRLS();
