CREATE TYPE "public"."actor_class" AS ENUM('human', 'declared_agent', 'suspected_agent', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."application_status" AS ENUM('draft', 'submitted', 'paid', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."approval_method" AS ENUM('passkey', 'device', 'otp');--> statement-breakpoint
CREATE TYPE "public"."policy_decision" AS ENUM('allow', 'gate', 'deny');--> statement-breakpoint
CREATE TYPE "public"."request_outcome" AS ENUM('executed', 'blocked', 'gated', 'error');--> statement-breakpoint
CREATE TYPE "public"."request_route" AS ENUM('web', 'api', 'mcp');--> statement-breakpoint
CREATE TYPE "public"."risk_state" AS ENUM('clean', 'agent_observed', 'handover_suspected');--> statement-breakpoint
CREATE TYPE "public"."signin_method" AS ENUM('password', 'passkey', 'oauth_mcp');--> statement-breakpoint
CREATE TYPE "public"."ticket_state" AS ENUM('pending', 'approved', 'rejected', 'expired', 'consumed');--> statement-breakpoint
CREATE TABLE "applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "application_status" DEFAULT 'draft' NOT NULL,
	"title" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"documents" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"submitted_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "applications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hitl_tickets" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"action" text NOT NULL,
	"resource_id" text,
	"payload_hash" text NOT NULL,
	"payload_preview" jsonb NOT NULL,
	"requested_by_actor" jsonb NOT NULL,
	"requesting_session_id" text,
	"requesting_client_id" text,
	"state" "ticket_state" DEFAULT 'pending' NOT NULL,
	"reject_reason" text,
	"approval_method" "approval_method",
	"approver_meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "hitl_tickets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "mcp_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"name" text NOT NULL,
	"redirect_uris" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_clients_client_id_unique" UNIQUE("client_id")
);
--> statement-breakpoint
ALTER TABLE "mcp_clients" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "passkeys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"credential_id" text NOT NULL,
	"public_key" text NOT NULL,
	"counter" integer DEFAULT 0 NOT NULL,
	"transports" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"aaguid" text,
	"attestation_format" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "passkeys_credential_id_unique" UNIQUE("credential_id")
);
--> statement-breakpoint
ALTER TABLE "passkeys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "request_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"route" "request_route" NOT NULL,
	"method" text NOT NULL,
	"path_or_tool" text NOT NULL,
	"user_id" uuid,
	"session_id" text,
	"run_id" text,
	"actor_class" "actor_class",
	"actor_signals" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"policy_decision" "policy_decision",
	"ticket_id" text,
	"outcome" "request_outcome" NOT NULL,
	"reason" text,
	"latency_ms" integer,
	"user_agent" text,
	"ip_hash" text
);
--> statement-breakpoint
ALTER TABLE "request_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "session_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"event" text NOT NULL,
	"from_state" "risk_state",
	"to_state" "risk_state",
	"trigger" text NOT NULL,
	"signals" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"declared_agent" boolean DEFAULT false NOT NULL,
	"signin_method" "signin_method" NOT NULL,
	"login_signals" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"login_actor_class" "actor_class" DEFAULT 'unknown' NOT NULL,
	"risk_state" "risk_state" DEFAULT 'clean' NOT NULL,
	"client_ctx_hash" text,
	"approval_only" boolean DEFAULT false NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoke_reason" text
);
--> statement-breakpoint
ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"phone" text,
	"recovery_email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hitl_tickets" ADD CONSTRAINT "hitl_tickets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkeys" ADD CONSTRAINT "passkeys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "applications_user_idx" ON "applications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "hitl_tickets_user_state_idx" ON "hitl_tickets" USING btree ("user_id","state");--> statement-breakpoint
CREATE INDEX "passkeys_user_idx" ON "passkeys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "request_log_ts_idx" ON "request_log" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "request_log_run_idx" ON "request_log" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "request_log_session_idx" ON "request_log" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "session_events_session_idx" ON "session_events" USING btree ("session_id","ts");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");