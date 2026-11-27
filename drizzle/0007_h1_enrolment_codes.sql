CREATE TABLE "passkey_enrolment_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "passkey_enrolment_codes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "passkey_enrolment_codes" ADD CONSTRAINT "passkey_enrolment_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "passkey_enrolment_codes_user_idx" ON "passkey_enrolment_codes" USING btree ("user_id");