ALTER TABLE "github_tokens" DROP CONSTRAINT "github_tokens_user_unique";--> statement-breakpoint
ALTER TABLE "github_tokens" ADD COLUMN "role" text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "github_tokens" ADD CONSTRAINT "github_tokens_user_role_unique" UNIQUE("user_id","role");--> statement-breakpoint
ALTER TABLE "github_tokens" ADD CONSTRAINT "github_tokens_role_known" CHECK ("github_tokens"."role" in ('agent', 'engine'));