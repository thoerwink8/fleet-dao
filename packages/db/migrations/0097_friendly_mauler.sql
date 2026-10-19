CREATE TABLE "task_execution_births" (
	"task_id" uuid PRIMARY KEY NOT NULL,
	"protocol_version" integer NOT NULL,
	"birth_request_id" uuid NOT NULL,
	"coverage_epoch" uuid NOT NULL,
	"namespace" text NOT NULL,
	"workflow_type" text NOT NULL,
	"task_queue" text NOT NULL,
	"birth_input_canonical" text NOT NULL,
	"birth_input_hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "task_execution_births_birth_request_id_unique" UNIQUE("birth_request_id"),
	CONSTRAINT "task_execution_births_protocol_known" CHECK ("task_execution_births"."protocol_version" = 1),
	CONSTRAINT "task_execution_births_identity_valid" CHECK (length(btrim("task_execution_births"."namespace")) > 0 and "task_execution_births"."workflow_type" = 'taskWorkflow' and length(btrim("task_execution_births"."task_queue")) > 0 and length(btrim("task_execution_births"."birth_input_canonical")) > 0 and "task_execution_births"."birth_input_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "task_legacy_execution_admissions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"schema_version" integer NOT NULL,
	"task_id" uuid NOT NULL,
	"namespace" text NOT NULL,
	"workflow_id" text NOT NULL,
	"run_id" uuid NOT NULL,
	"workflow_type" text NOT NULL,
	"task_queue" text NOT NULL,
	"generation" integer NOT NULL,
	"input_canonical" text NOT NULL,
	"input_hash" text NOT NULL,
	"admitted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "task_legacy_execution_admissions_run_unique" UNIQUE("namespace","run_id"),
	CONSTRAINT "task_legacy_execution_admissions_schema_known" CHECK ("task_legacy_execution_admissions"."schema_version" = 1),
	CONSTRAINT "task_legacy_execution_admissions_generation_range" CHECK ("task_legacy_execution_admissions"."generation" between 1 and 20),
	CONSTRAINT "task_legacy_execution_admissions_identity_valid" CHECK (length(btrim("task_legacy_execution_admissions"."namespace")) > 0 and length(btrim("task_legacy_execution_admissions"."workflow_id")) > 0 and "task_legacy_execution_admissions"."workflow_type" = 'taskWorkflow' and length(btrim("task_legacy_execution_admissions"."task_queue")) > 0 and length(btrim("task_legacy_execution_admissions"."input_canonical")) > 0 and "task_legacy_execution_admissions"."input_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "task_execution_births" ADD CONSTRAINT "task_execution_births_control_identity" FOREIGN KEY ("task_id","coverage_epoch") REFERENCES "public"."task_execution_controls"("task_id","coverage_epoch") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_legacy_execution_admissions" ADD CONSTRAINT "task_legacy_execution_admissions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;