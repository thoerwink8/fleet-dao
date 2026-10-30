CREATE TABLE "fleet2"."session_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"session_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "session_tokens_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "session_tokens_role_known" CHECK ("fleet2"."session_tokens"."role" in ('commander', 'worker'))
);
--> statement-breakpoint
CREATE INDEX "session_tokens_session_idx" ON "fleet2"."session_tokens" USING btree ("session_id");