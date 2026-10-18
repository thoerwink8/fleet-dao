CREATE TABLE "pr_head_files" (
	"repo_id" uuid NOT NULL,
	"pr_number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"path" text NOT NULL,
	"added" integer,
	"removed" integer,
	"binary" boolean DEFAULT false NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pr_head_files_pk" PRIMARY KEY("repo_id","pr_number","head_sha","path"),
	CONSTRAINT "pr_head_files_head_sha_shape" CHECK ("pr_head_files"."head_sha" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "pr_head_files_number_positive" CHECK ("pr_head_files"."pr_number" > 0),
	CONSTRAINT "pr_head_files_lines_nonneg" CHECK (("pr_head_files"."added" is null or "pr_head_files"."added" >= 0) and ("pr_head_files"."removed" is null or "pr_head_files"."removed" >= 0)),
	CONSTRAINT "pr_head_files_binary_shape" CHECK (("pr_head_files"."binary" and "pr_head_files"."added" is null and "pr_head_files"."removed" is null) or (not "pr_head_files"."binary" and "pr_head_files"."added" is not null and "pr_head_files"."removed" is not null))
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "cause" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "cause_summary" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "round_seq" integer;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "verdict" jsonb;--> statement-breakpoint
ALTER TABLE "task_rounds" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "task_rounds" ADD COLUMN "rework_summary" text;--> statement-breakpoint
ALTER TABLE "pr_head_files" ADD CONSTRAINT "pr_head_files_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pr_head_files_pr_idx" ON "pr_head_files" USING btree ("repo_id","pr_number");--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_cause_known" CHECK ("runs"."cause" is null or "runs"."cause" in ('plan', 'main', 'commit_nudge', 'self_check_fix', 'rework_ci', 'rework_verify', 'rework_review', 'rework_conflict', 'rework_no_commit', 'rework_other', 'retry', 'reroute', 'org_switch', 'pause_resume', 'repin', 'human_continue'));--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_cause_summary_short" CHECK ("runs"."cause_summary" is null or char_length("runs"."cause_summary") <= 500);--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_round_seq_positive" CHECK ("runs"."round_seq" is null or "runs"."round_seq" > 0);--> statement-breakpoint
ALTER TABLE "task_rounds" ADD CONSTRAINT "task_rounds_rework_summary_short" CHECK ("task_rounds"."rework_summary" is null or char_length("task_rounds"."rework_summary") <= 500);