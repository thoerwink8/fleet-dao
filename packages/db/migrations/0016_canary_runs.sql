CREATE TABLE "canary_runs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "canary_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"schedule_run_id" bigint NOT NULL,
	"repo" text,
	"issue_number" integer,
	"task_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"verdict" text,
	"stage" text NOT NULL,
	"why" text,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cleaned_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "canary_runs_verdict_known" CHECK ("canary_runs"."verdict" is null or "canary_runs"."verdict" in ('pass', 'broken', 'not_run')),
	CONSTRAINT "canary_runs_verdict_iff_ended" CHECK (("canary_runs"."ended_at" is null) = ("canary_runs"."verdict" is null)),
	CONSTRAINT "canary_runs_not_pass_has_why" CHECK ("canary_runs"."verdict" is null or "canary_runs"."verdict" = 'pass' or coalesce(length("canary_runs"."why"), 0) > 0),
	CONSTRAINT "canary_runs_stage_not_blank" CHECK (length("canary_runs"."stage") > 0),
	CONSTRAINT "canary_runs_steps_array" CHECK (jsonb_typeof("canary_runs"."steps") = 'array'),
	CONSTRAINT "canary_runs_issue_positive" CHECK ("canary_runs"."issue_number" is null or "canary_runs"."issue_number" > 0)
);
--> statement-breakpoint
ALTER TABLE "canary_runs" ADD CONSTRAINT "canary_runs_schedule_run_id_schedule_runs_id_fk" FOREIGN KEY ("schedule_run_id") REFERENCES "public"."schedule_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canary_runs" ADD CONSTRAINT "canary_runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "canary_runs_started_idx" ON "canary_runs" USING btree ("started_at");