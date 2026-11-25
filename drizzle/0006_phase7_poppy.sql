ALTER TYPE "public"."signin_method" ADD VALUE 'poppy_join';--> statement-breakpoint
CREATE TABLE "oauth_refresh_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"code_id" text NOT NULL,
	"scope" text NOT NULL,
	"resource" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "poppy_join_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"cookie_hash" text NOT NULL,
	"client_id" text,
	"sid" text,
	"user_id" uuid,
	"code_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"authorized_at" timestamp with time zone,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "poppy_join_codes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "poppy_jtis" (
	"key" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "poppy_jtis" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "poppy_links" (
	"client_id" text NOT NULL,
	"sub" text NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "poppy_links_client_id_sub_pk" PRIMARY KEY("client_id","sub")
);
--> statement-breakpoint
ALTER TABLE "poppy_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "poppy_sessions" (
	"client_id" text NOT NULL,
	"sid" text NOT NULL,
	"sub" text NOT NULL,
	"agent_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "poppy_sessions_client_id_sid_pk" PRIMARY KEY("client_id","sid")
);
--> statement-breakpoint
ALTER TABLE "poppy_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poppy_join_codes" ADD CONSTRAINT "poppy_join_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poppy_links" ADD CONSTRAINT "poppy_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_refresh_tokens_code_idx" ON "oauth_refresh_tokens" USING btree ("code_id");--> statement-breakpoint
CREATE INDEX "poppy_join_codes_expiry_idx" ON "poppy_join_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "poppy_jtis_expiry_idx" ON "poppy_jtis" USING btree ("expires_at");