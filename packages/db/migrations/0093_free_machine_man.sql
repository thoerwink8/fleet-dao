CREATE TABLE "pr_head_snapshots" (
	"repo_id" uuid NOT NULL,
	"pr_number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"status" text NOT NULL,
	"total" integer,
	"kept" integer NOT NULL,
	"reason" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pr_head_snapshots_repo_id_pr_number_head_sha_pk" PRIMARY KEY("repo_id","pr_number","head_sha"),
	CONSTRAINT "pr_head_snapshots_identity" CHECK ("pr_head_snapshots"."pr_number" > 0 and "pr_head_snapshots"."head_sha" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "pr_head_snapshots_shape" CHECK (("pr_head_snapshots"."status" = 'complete' and "pr_head_snapshots"."total" = "pr_head_snapshots"."kept" and "pr_head_snapshots"."total" is not null and "pr_head_snapshots"."reason" is null) or ("pr_head_snapshots"."status" = 'truncated' and "pr_head_snapshots"."total" is not null and "pr_head_snapshots"."total" > "pr_head_snapshots"."kept" and "pr_head_snapshots"."reason" is not null and length(trim("pr_head_snapshots"."reason")) > 0) or ("pr_head_snapshots"."status" = 'unavailable' and "pr_head_snapshots"."total" is null and "pr_head_snapshots"."kept" = 0 and "pr_head_snapshots"."reason" is not null and length(trim("pr_head_snapshots"."reason")) > 0)),
	CONSTRAINT "pr_head_snapshots_counts" CHECK ("pr_head_snapshots"."kept" between 0 and 500 and ("pr_head_snapshots"."total" is null or "pr_head_snapshots"."total" >= 0))
);
--> statement-breakpoint
CREATE TABLE "verify_aggregates" (
	"task_id" uuid NOT NULL,
	"workflow_id" text,
	"pr_number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"round" integer NOT NULL,
	"source_key" text NOT NULL,
	"source_run_ids" uuid[] NOT NULL,
	"verdict" jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verify_aggregates_task_id_pr_number_head_sha_round_source_key_pk" PRIMARY KEY("task_id","pr_number","head_sha","round","source_key"),
	CONSTRAINT "verify_aggregates_identity" CHECK ("verify_aggregates"."pr_number" > 0 and "verify_aggregates"."head_sha" ~ '^[0-9a-f]{40}$' and "verify_aggregates"."round" in (1, 2)),
	CONSTRAINT "verify_aggregates_sources" CHECK (cardinality("verify_aggregates"."source_run_ids") > 0 and "verify_aggregates"."source_key" = array_to_string("verify_aggregates"."source_run_ids", ','))
);
--> statement-breakpoint
ALTER TABLE "pr_head_snapshots" ADD CONSTRAINT "pr_head_snapshots_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verify_aggregates" ADD CONSTRAINT "verify_aggregates_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;