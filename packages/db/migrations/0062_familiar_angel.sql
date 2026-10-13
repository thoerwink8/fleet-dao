CREATE TABLE "github_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"github_id" bigint NOT NULL,
	"login" text NOT NULL,
	"access_token_cipher" text NOT NULL,
	"scopes" text DEFAULT '' NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_tokens_user_unique" UNIQUE("user_id"),
	CONSTRAINT "github_tokens_cipher_not_empty" CHECK (length("github_tokens"."access_token_cipher") > 0)
);
--> statement-breakpoint
ALTER TABLE "github_tokens" ADD CONSTRAINT "github_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "github_tokens_github_id_idx" ON "github_tokens" USING btree ("github_id");