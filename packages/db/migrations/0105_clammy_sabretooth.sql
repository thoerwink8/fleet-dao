ALTER TABLE "tasks" ADD COLUMN "owner" text DEFAULT 'v1' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "fencing" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_owner_known" CHECK ("tasks"."owner" in ('v1', 'harness'));