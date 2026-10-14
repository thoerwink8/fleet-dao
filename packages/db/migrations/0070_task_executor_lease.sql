ALTER TABLE "tasks" ADD COLUMN "executor" text DEFAULT 'engine' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "claimed_by" text;--> statement-breakpoint
CREATE INDEX "tasks_local_lease_idx" ON "tasks" USING btree ("lease_until") WHERE "tasks"."executor" = 'local';--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_executor_known" CHECK ("tasks"."executor" in ('engine', 'local'));