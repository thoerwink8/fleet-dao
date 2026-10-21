CREATE TABLE "acceptance_candidate_bootstrap" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"semantics_version" integer NOT NULL,
	"cursor_id" bigint DEFAULT 0 NOT NULL,
	"high_water_id" bigint NOT NULL,
	"ready" boolean DEFAULT false NOT NULL,
	CONSTRAINT "acceptance_candidate_bootstrap_singleton" CHECK ("acceptance_candidate_bootstrap"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "acceptance_candidate_groups" (
	"task_id" uuid NOT NULL,
	"pr_number" integer NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"dirty" boolean DEFAULT true NOT NULL,
	"has_open" boolean DEFAULT false NOT NULL,
	"last_attempt_at" timestamp with time zone,
	CONSTRAINT "acceptance_candidate_groups_task_id_pr_number_pk" PRIMARY KEY("task_id","pr_number")
);
--> statement-breakpoint
ALTER TABLE "acceptance_candidate_groups" ADD CONSTRAINT "acceptance_candidate_groups_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "acceptance_candidate_dirty_idx" ON "acceptance_candidate_groups" USING btree ("last_attempt_at" NULLS FIRST,"task_id","pr_number") WHERE "acceptance_candidate_groups"."dirty";--> statement-breakpoint
CREATE INDEX "acceptance_candidate_open_idx" ON "acceptance_candidate_groups" USING btree ("task_id","pr_number") WHERE "acceptance_candidate_groups"."has_open";--> statement-breakpoint
CREATE INDEX "runs_task_workflow_latest_idx" ON "runs" USING btree ("task_id","started_at" DESC NULLS LAST,"created_at" DESC NULLS LAST) WHERE "runs"."workflow_id" is not null;