ALTER TABLE "issue_claims" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "seat_boards" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "seat_leases" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "issue_claims" CASCADE;--> statement-breakpoint
DROP TABLE "seat_boards" CASCADE;--> statement-breakpoint
DROP TABLE "seat_leases" CASCADE;--> statement-breakpoint
ALTER TABLE "repos" DROP CONSTRAINT "repos_flow_source_known";--> statement-breakpoint
ALTER TABLE "repos" DROP CONSTRAINT "repos_flow_synced_together";--> statement-breakpoint
ALTER TABLE "repos" DROP CONSTRAINT "repos_flow_reasons_not_blank";--> statement-breakpoint
ALTER TABLE "repos" DROP CONSTRAINT "repos_flow_config_shape";--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_flow_source_known";--> statement-breakpoint
ALTER TABLE "repos" DROP COLUMN "flow_config";--> statement-breakpoint
ALTER TABLE "repos" DROP COLUMN "flow_source";--> statement-breakpoint
ALTER TABLE "repos" DROP COLUMN "flow_commit";--> statement-breakpoint
ALTER TABLE "repos" DROP COLUMN "flow_synced_at";--> statement-breakpoint
ALTER TABLE "repos" DROP COLUMN "flow_error";--> statement-breakpoint
ALTER TABLE "repos" DROP COLUMN "flow_checked_at";--> statement-breakpoint
ALTER TABLE "repos" DROP COLUMN "flow_unread";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "flow_source";