ALTER TABLE "repos" ADD COLUMN "github_id" bigint;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "profile" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_github_id_unique" UNIQUE("github_id");