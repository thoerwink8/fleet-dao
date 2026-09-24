CREATE TYPE "public"."actor_kind" AS ENUM('user', 'ai', 'engine', 'agent');--> statement-breakpoint
CREATE TYPE "public"."audit_via" AS ENUM('cockpit', 'feishu', 'github', 'engine', 'agent');--> statement-breakpoint
CREATE TYPE "public"."billing_kind" AS ENUM('subscription', 'metered');--> statement-breakpoint
CREATE TYPE "public"."host_id" AS ENUM('claude-code', 'codex', 'cursor-agent', 'grok', 'mirasim', 'api-shell');--> statement-breakpoint
CREATE TYPE "public"."jev_mode" AS ENUM('shadow', 'enforce', 'off');--> statement-breakpoint
CREATE TYPE "public"."jev_question_type" AS ENUM('noul', 'choice');--> statement-breakpoint
CREATE TYPE "public"."jev_truth_source" AS ENUM('human', 'outcome', 'canary');--> statement-breakpoint
CREATE TYPE "public"."notification_level" AS ENUM('decision', 'alert', 'daily');--> statement-breakpoint
CREATE TYPE "public"."pr_checks" AS ENUM('success', 'failure', 'pending', 'none');--> statement-breakpoint
CREATE TYPE "public"."pr_state" AS ENUM('open', 'closed', 'merged');--> statement-breakpoint
CREATE TYPE "public"."progress_kind" AS ENUM('plan', 'say', 'tool', 'file', 'test', 'ask', 'done', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."quota_status" AS ENUM('allowed', 'warning', 'limit_reached');--> statement-breakpoint
CREATE TYPE "public"."quota_window_kind" AS ENUM('5h', '7d', '7d_model', 'month_usd', 'points', 'period_usd');--> statement-breakpoint
CREATE TYPE "public"."reading_kind" AS ENUM('measured', 'estimated');--> statement-breakpoint
CREATE TYPE "public"."run_outcome" AS ENUM('ok', 'failed', 'stopped', 'stalled');--> statement-breakpoint
CREATE TYPE "public"."schedule_outcome" AS ENUM('ok', 'partial', 'unscanned', 'failed');--> statement-breakpoint
CREATE TYPE "public"."stage_kind" AS ENUM('triage', 'spec', 'plan', 'execute', 'ui', 'review', 'research', 'judge');--> statement-breakpoint
CREATE TYPE "public"."state_entity" AS ENUM('task', 'subtask');--> statement-breakpoint
CREATE TYPE "public"."subtask_state" AS ENUM('pending', 'waiting_deps', 'waiting_slot', 'running', 'verifying', 'in_merge_queue', 'merged', 'stopped', 'failed', 'stalled');--> statement-breakpoint
CREATE TYPE "public"."task_state" AS ENUM('queued', 'triaging', 'asking', 'planning', 'running', 'merging', 'done', 'stopped', 'failed', 'stalled');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('founder', 'collaborator', 'bot');--> statement-breakpoint
CREATE TABLE "bans" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "bans_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"family" text,
	"model_id" text,
	"stage" "stage_kind",
	"reason" text NOT NULL,
	CONSTRAINT "bans_target_stage_unique" UNIQUE NULLS NOT DISTINCT("family","model_id","stage"),
	CONSTRAINT "bans_target_required" CHECK ("bans"."family" is not null or "bans"."model_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"billing" "billing_kind" NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "families" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"vendor" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "models" (
	"id" text PRIMARY KEY NOT NULL,
	"family" text NOT NULL,
	"display_name" text NOT NULL,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "pools" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"max_concurrency" integer NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "pools_channel_id_id_unique" UNIQUE("channel_id","id"),
	CONSTRAINT "pools_max_concurrency_positive" CHECK ("pools"."max_concurrency" > 0)
);
--> statement-breakpoint
CREATE TABLE "quota_windows" (
	"pool_id" text NOT NULL,
	"window" "quota_window_kind" NOT NULL,
	"scope" text DEFAULT '' NOT NULL,
	"utilization" double precision,
	"used" double precision,
	"limit" double precision,
	"resets_at" timestamp with time zone,
	"upstream_status" "quota_status",
	"reading" "reading_kind" NOT NULL,
	"read_at" timestamp with time zone NOT NULL,
	CONSTRAINT "quota_windows_pool_id_window_scope_pk" PRIMARY KEY("pool_id","window","scope"),
	CONSTRAINT "quota_windows_utilization_nonneg" CHECK ("quota_windows"."utilization" is null or "quota_windows"."utilization" >= 0),
	CONSTRAINT "quota_windows_model_scope" CHECK (("quota_windows"."window" = '7d_model') = ("quota_windows"."scope" <> ''))
);
--> statement-breakpoint
CREATE TABLE "routes" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"pool_id" text NOT NULL,
	"model_id" text NOT NULL,
	"host_id" "host_id" NOT NULL,
	"alive" boolean DEFAULT false NOT NULL,
	CONSTRAINT "routes_pool_model_host_unique" UNIQUE("pool_id","model_id","host_id")
);
--> statement-breakpoint
CREATE TABLE "stage_policies" (
	"stage" "stage_kind" PRIMARY KEY NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stage_policy_routes" (
	"stage" "stage_kind" NOT NULL,
	"route_id" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "stage_policy_routes_stage_route_id_pk" PRIMARY KEY("stage","route_id"),
	CONSTRAINT "stage_policy_routes_stage_position_unique" UNIQUE("stage","position"),
	CONSTRAINT "stage_policy_routes_position_nonneg" CHECK ("stage_policy_routes"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_kind" "actor_kind" NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"target" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"reason" text,
	"via" "audit_via" NOT NULL,
	"ok" boolean DEFAULT true NOT NULL,
	"error" text,
	CONSTRAINT "audit_log_failure_has_error" CHECK ("audit_log"."ok" or "audit_log"."error" is not null)
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"key" text PRIMARY KEY NOT NULL,
	"action" text NOT NULL,
	"target" text,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"result" jsonb
);
--> statement-breakpoint
CREATE TABLE "jev_answers" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "jev_answers_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"question_id" text NOT NULL,
	"asked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"subject" text NOT NULL,
	"sample" jsonb NOT NULL,
	"shadow" boolean NOT NULL,
	"ok" boolean NOT NULL,
	"answer" text,
	"confidence" double precision,
	"fail_reason" text,
	"model_version" text,
	"latency_ms" integer,
	"input_tokens" integer,
	"truth" text,
	"truth_source" "jev_truth_source",
	"truth_by" uuid,
	"truth_at" timestamp with time zone,
	CONSTRAINT "jev_answers_ok_shape" CHECK (case when "jev_answers"."ok" then "jev_answers"."answer" is not null and "jev_answers"."confidence" is not null and "jev_answers"."fail_reason" is null else "jev_answers"."answer" is null and "jev_answers"."fail_reason" is not null end),
	CONSTRAINT "jev_answers_confidence_range" CHECK ("jev_answers"."confidence" is null or "jev_answers"."confidence" between 0 and 1),
	CONSTRAINT "jev_answers_truth_shape" CHECK (("jev_answers"."truth" is null) = ("jev_answers"."truth_source" is null))
);
--> statement-breakpoint
CREATE TABLE "jev_questions" (
	"id" text PRIMARY KEY NOT NULL,
	"site" text NOT NULL,
	"prompt" text NOT NULL,
	"type" "jev_question_type" NOT NULL,
	"options" text[],
	"mode" "jev_mode" DEFAULT 'shadow' NOT NULL,
	"confidence_line" double precision NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jev_questions_choice_has_options" CHECK (("jev_questions"."type" = 'choice') = ("jev_questions"."options" is not null and cardinality("jev_questions"."options") >= 2)),
	CONSTRAINT "jev_questions_confidence_line_range" CHECK ("jev_questions"."confidence_line" between 0 and 1),
	CONSTRAINT "jev_questions_model_pinned" CHECK ("jev_questions"."model" not ilike '%latest%')
);
--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "notification_deliveries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"notification_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"target" text NOT NULL,
	"message_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"last_attempt_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "notification_deliveries_target_unique" UNIQUE("notification_id","channel","target"),
	CONSTRAINT "notification_deliveries_delivered_needs_message_id" CHECK ("notification_deliveries"."delivered_at" is null or "notification_deliveries"."message_id" is not null),
	CONSTRAINT "notification_deliveries_attempts_nonneg" CHECK ("notification_deliveries"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"level" "notification_level" NOT NULL,
	"dedupe_key" text NOT NULL,
	"task_id" uuid,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"link" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	CONSTRAINT "notifications_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "schedule_runs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "schedule_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"job" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"outcome" "schedule_outcome",
	"scanned" integer,
	"found" integer,
	"why" text,
	CONSTRAINT "schedule_runs_outcome_iff_ended" CHECK (("schedule_runs"."ended_at" is null) = ("schedule_runs"."outcome" is null)),
	CONSTRAINT "schedule_runs_ok_scanned_something" CHECK ("schedule_runs"."outcome" is distinct from 'ok' or ("schedule_runs"."scanned" > 0 and "schedule_runs"."found" is not null)),
	CONSTRAINT "schedule_runs_unscanned_is_zero" CHECK ("schedule_runs"."outcome" is distinct from 'unscanned' or coalesce("schedule_runs"."scanned", 0) = 0),
	CONSTRAINT "schedule_runs_not_ok_has_why" CHECK ("schedule_runs"."outcome" is null or "schedule_runs"."outcome" = 'ok' or "schedule_runs"."why" is not null),
	CONSTRAINT "schedule_runs_counts_nonneg" CHECK (coalesce("schedule_runs"."scanned", 0) >= 0 and coalesce("schedule_runs"."found", 0) >= 0)
);
--> statement-breakpoint
CREATE TABLE "scheduled_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"schedule" text NOT NULL,
	"expect_every_minutes" integer NOT NULL,
	CONSTRAINT "scheduled_jobs_expect_every_positive" CHECK ("scheduled_jobs"."expect_every_minutes" > 0)
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	CONSTRAINT "settings_version_positive" CHECK ("settings"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text NOT NULL,
	"role" "user_role" NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"avatar_url" text,
	"feishu_open_id" text,
	"feishu_union_id" text,
	"github_login" text,
	"github_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_feishu_open_id_unique" UNIQUE("feishu_open_id"),
	CONSTRAINT "users_feishu_union_id_unique" UNIQUE("feishu_union_id"),
	CONSTRAINT "users_github_id_unique" UNIQUE("github_id")
);
--> statement-breakpoint
CREATE TABLE "asks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"run_id" uuid,
	"question" text NOT NULL,
	"options" text[] DEFAULT '{}'::text[] NOT NULL,
	"asked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answer" text,
	"answered_by" text,
	"answered_at" timestamp with time zone,
	CONSTRAINT "asks_answer_shape" CHECK (("asks"."answer" is null) = ("asks"."answered_at" is null) and ("asks"."answer" is null) = ("asks"."answered_by" is null))
);
--> statement-breakpoint
CREATE TABLE "progress_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "progress_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"run_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" "progress_kind" NOT NULL,
	"payload" jsonb,
	CONSTRAINT "progress_events_plan_has_steps" CHECK ("progress_events"."kind" <> 'plan' or coalesce(jsonb_typeof("progress_events"."payload" -> 'steps') = 'array', false))
);
--> statement-breakpoint
CREATE TABLE "pull_requests" (
	"repo_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"state" "pr_state" NOT NULL,
	"head_ref" text NOT NULL,
	"head_sha" text NOT NULL,
	"checks" "pr_checks" DEFAULT 'none' NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pull_requests_repo_id_number_pk" PRIMARY KEY("repo_id","number"),
	CONSTRAINT "pull_requests_number_positive" CHECK ("pull_requests"."number" > 0)
);
--> statement-breakpoint
CREATE TABLE "repos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"test_command" text NOT NULL,
	CONSTRAINT "repos_owner_name_unique" UNIQUE("owner","name")
);
--> statement-breakpoint
CREATE TABLE "session_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid,
	"subtask_id" uuid,
	"stage" "stage_kind" NOT NULL,
	"route_id" text NOT NULL,
	"why_route" text NOT NULL,
	"branch" text,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"outcome" "run_outcome",
	"actual_model" text,
	"input_tokens" bigint,
	"output_tokens" bigint,
	"cost_usd" numeric(14, 6),
	"queue_ms" bigint GENERATED ALWAYS AS ((extract(epoch from (coalesce(started_at, ended_at) - queued_at)) * 1000)::bigint) STORED,
	"run_ms" bigint GENERATED ALWAYS AS ((extract(epoch from (ended_at - started_at)) * 1000)::bigint) STORED,
	CONSTRAINT "session_runs_task_id_id_unique" UNIQUE("task_id","id"),
	CONSTRAINT "session_runs_subtask_needs_task" CHECK ("session_runs"."subtask_id" is null or "session_runs"."task_id" is not null),
	CONSTRAINT "session_runs_outcome_iff_ended" CHECK (("session_runs"."ended_at" is null) = ("session_runs"."outcome" is null)),
	CONSTRAINT "session_runs_started_after_queued" CHECK ("session_runs"."started_at" is null or "session_runs"."started_at" >= "session_runs"."queued_at"),
	CONSTRAINT "session_runs_ended_after_start" CHECK ("session_runs"."ended_at" is null or "session_runs"."ended_at" >= coalesce("session_runs"."started_at", "session_runs"."queued_at")),
	CONSTRAINT "session_runs_usage_nonneg" CHECK (coalesce("session_runs"."input_tokens", 0) >= 0 and coalesce("session_runs"."output_tokens", 0) >= 0 and coalesce("session_runs"."cost_usd", 0) >= 0)
);
--> statement-breakpoint
CREATE TABLE "specs" (
	"task_id" uuid PRIMARY KEY NOT NULL,
	"summary" text NOT NULL,
	"result_summary" text,
	"merged_at" timestamp with time zone,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "state_changes" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "state_changes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"entity" "state_entity" NOT NULL,
	"entity_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subtask_deps" (
	"task_id" uuid NOT NULL,
	"subtask_id" uuid NOT NULL,
	"depends_on_id" uuid NOT NULL,
	CONSTRAINT "subtask_deps_subtask_id_depends_on_id_pk" PRIMARY KEY("subtask_id","depends_on_id"),
	CONSTRAINT "subtask_deps_not_self" CHECK ("subtask_deps"."subtask_id" <> "subtask_deps"."depends_on_id")
);
--> statement-breakpoint
CREATE TABLE "subtasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"index" integer NOT NULL,
	"title" text NOT NULL,
	"touches" text[] DEFAULT '{}'::text[] NOT NULL,
	"state" "subtask_state" DEFAULT 'pending' NOT NULL,
	"pr_number" integer,
	"waiting_on" text,
	CONSTRAINT "subtasks_task_index_unique" UNIQUE("task_id","index"),
	CONSTRAINT "subtasks_task_id_id_unique" UNIQUE("task_id","id")
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"issue_number" integer NOT NULL,
	"title" text NOT NULL,
	"raw_request" text NOT NULL,
	"requested_by" text NOT NULL,
	"state" "task_state" DEFAULT 'queued' NOT NULL,
	"priority" integer NOT NULL,
	"spec_dir" text,
	"acceptance" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_repo_issue_unique" UNIQUE("repo_id","issue_number"),
	CONSTRAINT "tasks_issue_number_positive" CHECK ("tasks"."issue_number" > 0)
);
--> statement-breakpoint
ALTER TABLE "bans" ADD CONSTRAINT "bans_family_families_id_fk" FOREIGN KEY ("family") REFERENCES "public"."families"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bans" ADD CONSTRAINT "bans_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "models" ADD CONSTRAINT "models_family_families_id_fk" FOREIGN KEY ("family") REFERENCES "public"."families"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pools" ADD CONSTRAINT "pools_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quota_windows" ADD CONSTRAINT "quota_windows_pool_id_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."pools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routes" ADD CONSTRAINT "routes_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routes" ADD CONSTRAINT "routes_pool_in_channel_fk" FOREIGN KEY ("channel_id","pool_id") REFERENCES "public"."pools"("channel_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_policy_routes" ADD CONSTRAINT "stage_policy_routes_stage_stage_policies_stage_fk" FOREIGN KEY ("stage") REFERENCES "public"."stage_policies"("stage") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_policy_routes" ADD CONSTRAINT "stage_policy_routes_route_id_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."routes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jev_answers" ADD CONSTRAINT "jev_answers_question_id_jev_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."jev_questions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jev_answers" ADD CONSTRAINT "jev_answers_truth_by_users_id_fk" FOREIGN KEY ("truth_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_job_scheduled_jobs_id_fk" FOREIGN KEY ("job") REFERENCES "public"."scheduled_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asks" ADD CONSTRAINT "asks_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asks" ADD CONSTRAINT "asks_run_in_task_fk" FOREIGN KEY ("task_id","run_id") REFERENCES "public"."session_runs"("task_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "progress_events" ADD CONSTRAINT "progress_events_run_id_session_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."session_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_runs" ADD CONSTRAINT "session_runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_runs" ADD CONSTRAINT "session_runs_route_id_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."routes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_runs" ADD CONSTRAINT "session_runs_subtask_in_task_fk" FOREIGN KEY ("task_id","subtask_id") REFERENCES "public"."subtasks"("task_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specs" ADD CONSTRAINT "specs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "state_changes" ADD CONSTRAINT "state_changes_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subtask_deps" ADD CONSTRAINT "subtask_deps_subtask_fk" FOREIGN KEY ("task_id","subtask_id") REFERENCES "public"."subtasks"("task_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subtask_deps" ADD CONSTRAINT "subtask_deps_depends_on_fk" FOREIGN KEY ("task_id","depends_on_id") REFERENCES "public"."subtasks"("task_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subtasks" ADD CONSTRAINT "subtasks_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_at_idx" ON "audit_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "audit_log_target_idx" ON "audit_log" USING btree ("target","at");--> statement-breakpoint
CREATE INDEX "idempotency_keys_claimed_at_idx" ON "idempotency_keys" USING btree ("claimed_at");--> statement-breakpoint
CREATE INDEX "jev_answers_question_idx" ON "jev_answers" USING btree ("question_id","asked_at");--> statement-breakpoint
CREATE INDEX "notifications_task_idx" ON "notifications" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "notifications_open_idx" ON "notifications" USING btree ("created_at") WHERE "notifications"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "schedule_runs_job_started_idx" ON "schedule_runs" USING btree ("job","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "asks_run_question_unique" ON "asks" USING btree ("run_id",md5("question"));--> statement-breakpoint
CREATE INDEX "asks_task_idx" ON "asks" USING btree ("task_id","asked_at");--> statement-breakpoint
CREATE INDEX "progress_events_run_at_idx" ON "progress_events" USING btree ("run_id","at");--> statement-breakpoint
CREATE INDEX "session_runs_task_idx" ON "session_runs" USING btree ("task_id","queued_at");--> statement-breakpoint
CREATE INDEX "session_runs_open_idx" ON "session_runs" USING btree ("route_id") WHERE "session_runs"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "state_changes_task_at_idx" ON "state_changes" USING btree ("task_id","at");--> statement-breakpoint
CREATE INDEX "state_changes_entity_id_idx" ON "state_changes" USING btree ("entity_id","id");