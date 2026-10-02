CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"segment" text NOT NULL,
	"task_id" uuid,
	"issue_number" integer,
	"model" text NOT NULL,
	"channel" text,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"outcome" text,
	"input_tokens" bigint,
	"output_tokens" bigint,
	"cache_read_tokens" bigint,
	"cache_write_tokens" bigint,
	"cost_usd" numeric(14, 6),
	"memory_peak_mb" integer,
	"failure_reason" text,
	"pr_number" integer,
	"branch" text,
	"workflow_id" text,
	"temporal_run_id" text,
	"retry_of" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runs_segment_known" CHECK ("runs"."segment" in ('scope', 'manual', 'verify')),
	CONSTRAINT "runs_outcome_known" CHECK ("runs"."outcome" is null or "runs"."outcome" in ('done', 'timeout', 'killed', 'spawn_failed', 'admission_blocked', 'failed')),
	CONSTRAINT "runs_outcome_iff_ended" CHECK (("runs"."ended_at" is null) = ("runs"."outcome" is null)),
	CONSTRAINT "runs_ended_after_start" CHECK ("runs"."ended_at" is null or "runs"."ended_at" >= "runs"."started_at"),
	CONSTRAINT "runs_issue_positive" CHECK ("runs"."issue_number" is null or "runs"."issue_number" > 0),
	CONSTRAINT "runs_pr_positive" CHECK ("runs"."pr_number" is null or "runs"."pr_number" > 0),
	CONSTRAINT "runs_usage_nonneg" CHECK (coalesce("runs"."input_tokens", 0) >= 0 and coalesce("runs"."output_tokens", 0) >= 0 and coalesce("runs"."cache_read_tokens", 0) >= 0 and coalesce("runs"."cache_write_tokens", 0) >= 0 and coalesce("runs"."cost_usd", 0) >= 0),
	CONSTRAINT "runs_memory_nonneg" CHECK ("runs"."memory_peak_mb" is null or "runs"."memory_peak_mb" >= 0)
);
--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_retry_of_self_fk" FOREIGN KEY ("retry_of") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runs_task_idx" ON "runs" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "runs_segment_created_idx" ON "runs" USING btree ("segment","created_at");--> statement-breakpoint
CREATE INDEX "runs_workflow_idx" ON "runs" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "runs_pr_idx" ON "runs" USING btree ("pr_number");--> statement-breakpoint
CREATE INDEX "runs_open_idx" ON "runs" USING btree ("segment") WHERE "runs"."ended_at" is null;