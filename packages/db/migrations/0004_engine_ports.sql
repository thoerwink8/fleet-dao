-- 引擎真端口要用的表：叫停请求、人闸批准、执行计时，外加 session_runs / tasks / subtasks 补的列。
-- drizzle-kit 生成不了触发器，approvals 的实时通知照 0001 的写法手写在文件末尾。
CREATE TABLE "step_timings" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "step_timings_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"workflow_id" text NOT NULL,
	"temporal_run_id" text NOT NULL,
	"workflow_type" text NOT NULL,
	"task_id" uuid,
	"subtask_id" uuid,
	"subtask_key" text,
	"activity" text,
	"attempt" integer,
	"wait_for" text,
	"detail" text,
	"scheduled_at" timestamp with time zone,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"queue_ms" bigint,
	"run_ms" bigint,
	"wait_ms" bigint,
	"outcome" text,
	"error_code" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "step_timings_kind_known" CHECK ("step_timings"."kind" in ('activity', 'wait')),
	CONSTRAINT "step_timings_ended_after_started" CHECK ("step_timings"."ended_at" >= "step_timings"."started_at"),
	CONSTRAINT "step_timings_activity_shape" CHECK ("step_timings"."kind" <> 'activity' or ("step_timings"."activity" is not null and "step_timings"."attempt" is not null and "step_timings"."scheduled_at" is not null and "step_timings"."queue_ms" is not null and "step_timings"."run_ms" is not null and "step_timings"."outcome" is not null)),
	CONSTRAINT "step_timings_wait_shape" CHECK ("step_timings"."kind" <> 'wait' or ("step_timings"."wait_for" is not null and "step_timings"."wait_ms" is not null)),
	CONSTRAINT "step_timings_outcome_known" CHECK ("step_timings"."outcome" is null or "step_timings"."outcome" in ('ok', 'failed', 'cancelled')),
	CONSTRAINT "step_timings_ms_nonneg" CHECK (coalesce("step_timings"."queue_ms", 0) >= 0 and coalesce("step_timings"."run_ms", 0) >= 0 and coalesce("step_timings"."wait_ms", 0) >= 0)
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"subtask_id" uuid,
	"holds" text[] NOT NULL,
	"pr_number" integer NOT NULL,
	"head" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decision" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"reason" text,
	CONSTRAINT "approvals_pr_number_positive" CHECK ("approvals"."pr_number" > 0),
	CONSTRAINT "approvals_decision_shape" CHECK (("approvals"."decision" is null) = ("approvals"."decided_by" is null) and ("approvals"."decision" is null) = ("approvals"."decided_at" is null)),
	CONSTRAINT "approvals_decision_known" CHECK ("approvals"."decision" is null or "approvals"."decision" in ('approved', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "session_stops" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subtasks" DROP CONSTRAINT "subtasks_task_index_unique";--> statement-breakpoint
ALTER TABLE "session_runs" DROP CONSTRAINT "session_runs_usage_nonneg";--> statement-breakpoint
ALTER TABLE "session_runs" ADD COLUMN "session_id" text;--> statement-breakpoint
ALTER TABLE "session_runs" ADD COLUMN "workflow_id" text;--> statement-breakpoint
ALTER TABLE "session_runs" ADD COLUMN "run_as_user" text;--> statement-breakpoint
ALTER TABLE "session_runs" ADD COLUMN "worktree_path" text;--> statement-breakpoint
ALTER TABLE "session_runs" ADD COLUMN "handle" jsonb;--> statement-breakpoint
ALTER TABLE "session_runs" ADD COLUMN "failure_code" text;--> statement-breakpoint
ALTER TABLE "session_runs" ADD COLUMN "failure_message" text;--> statement-breakpoint
ALTER TABLE "session_runs" ADD COLUMN "route_outcome" text;--> statement-breakpoint
ALTER TABLE "session_runs" ADD COLUMN "session_cost_usd" numeric(14, 6);--> statement-breakpoint
ALTER TABLE "session_runs" ADD COLUMN "context_tokens" bigint;--> statement-breakpoint
ALTER TABLE "subtasks" ADD COLUMN "key" text;--> statement-breakpoint
ALTER TABLE "subtasks" ADD COLUMN "workflow_id" text;--> statement-breakpoint
ALTER TABLE "subtasks" ADD COLUMN "holds" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "subtasks" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "phase" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "doing" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "docs" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "last_problem" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_subtask_in_task_fk" FOREIGN KEY ("task_id","subtask_id") REFERENCES "public"."subtasks"("task_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "step_timings_activity_unique" ON "step_timings" USING btree ("workflow_id","temporal_run_id","activity","attempt","scheduled_at") WHERE "step_timings"."kind" = 'activity';--> statement-breakpoint
CREATE UNIQUE INDEX "step_timings_wait_unique" ON "step_timings" USING btree ("workflow_id","temporal_run_id","wait_for","started_at") WHERE "step_timings"."kind" = 'wait';--> statement-breakpoint
CREATE INDEX "step_timings_task_started_idx" ON "step_timings" USING btree ("task_id","started_at");--> statement-breakpoint
CREATE INDEX "session_runs_session_id_idx" ON "session_runs" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subtasks_task_index_unique" ON "subtasks" USING btree ("task_id","index") WHERE "subtasks"."superseded_at" is null;--> statement-breakpoint
ALTER TABLE "session_runs" ADD CONSTRAINT "session_runs_run_as_user_known" CHECK ("session_runs"."run_as_user" is null or "session_runs"."run_as_user" in ('fleet-agent-dedicated', 'fleet-agent-carpool'));--> statement-breakpoint
ALTER TABLE "session_runs" ADD CONSTRAINT "session_runs_route_outcome_known" CHECK ("session_runs"."route_outcome" is null or "session_runs"."route_outcome" in ('ok', 'fail', 'neutral'));--> statement-breakpoint
ALTER TABLE "session_runs" ADD CONSTRAINT "session_runs_usage_nonneg" CHECK (coalesce("session_runs"."input_tokens", 0) >= 0 and coalesce("session_runs"."output_tokens", 0) >= 0 and coalesce("session_runs"."cost_usd", 0) >= 0 and coalesce("session_runs"."session_cost_usd", 0) >= 0 and coalesce("session_runs"."context_tokens", 0) >= 0);
--> statement-breakpoint
DROP TRIGGER IF EXISTS approvals_notify ON approvals;
--> statement-breakpoint
CREATE TRIGGER approvals_notify AFTER INSERT OR UPDATE OR DELETE ON approvals
  FOR EACH ROW EXECUTE FUNCTION fleet_notify_change('id');