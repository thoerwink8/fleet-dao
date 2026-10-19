CREATE TABLE "task_execution_controls" (
	"task_id" uuid PRIMARY KEY NOT NULL,
	"protocol_version" integer NOT NULL,
	"coverage_epoch" uuid NOT NULL,
	"revision" bigint NOT NULL,
	"current_operation_id" uuid,
	CONSTRAINT "task_execution_controls_protocol_known" CHECK ("task_execution_controls"."protocol_version" = 1),
	CONSTRAINT "task_execution_controls_revision_safe" CHECK ("task_execution_controls"."revision" between 0 and 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "task_execution_operations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"coverage_epoch" uuid NOT NULL,
	"revision" bigint NOT NULL,
	"request_id" uuid NOT NULL,
	"node_id" text NOT NULL,
	"kind" text NOT NULL,
	"namespace" text NOT NULL,
	"workflow_id" text NOT NULL,
	"generation" integer NOT NULL,
	"workflow_type" text NOT NULL,
	"input_hash" text NOT NULL,
	"phase" text NOT NULL,
	"admitted_run_id" text,
	"resolved_reason" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"dispatched_at" timestamp with time zone,
	"admitted_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "task_execution_operations_task_id_id_unique" UNIQUE("task_id","id"),
	CONSTRAINT "task_execution_operations_current_identity" UNIQUE("task_id","id","coverage_epoch","revision"),
	CONSTRAINT "task_execution_operations_request_unique" UNIQUE("task_id","request_id"),
	CONSTRAINT "task_execution_operations_revision_unique" UNIQUE("task_id","revision"),
	CONSTRAINT "task_execution_operations_revision_safe" CHECK ("task_execution_operations"."revision" between 1 and 9007199254740991),
	CONSTRAINT "task_execution_operations_generation_range" CHECK ("task_execution_operations"."generation" between 1 and 20),
	CONSTRAINT "task_execution_operations_identity_nonempty" CHECK (length(btrim("task_execution_operations"."node_id")) > 0 and length(btrim("task_execution_operations"."namespace")) > 0 and length(btrim("task_execution_operations"."workflow_id")) > 0 and length(btrim("task_execution_operations"."workflow_type")) > 0 and length(btrim("task_execution_operations"."input_hash")) > 0),
	CONSTRAINT "task_execution_operations_kind_known" CHECK ("task_execution_operations"."kind" in ('start', 'redo')),
	CONSTRAINT "task_execution_operations_phase_fields" CHECK (
    ("task_execution_operations"."phase" = 'reserved' and "task_execution_operations"."admitted_run_id" is null and "task_execution_operations"."resolved_reason" is null and "task_execution_operations"."dispatched_at" is null and "task_execution_operations"."admitted_at" is null and "task_execution_operations"."resolved_at" is null)
    or ("task_execution_operations"."phase" = 'dispatching' and "task_execution_operations"."admitted_run_id" is null and "task_execution_operations"."resolved_reason" is null and "task_execution_operations"."dispatched_at" is not null and "task_execution_operations"."admitted_at" is null and "task_execution_operations"."resolved_at" is null)
    or ("task_execution_operations"."phase" = 'admitted' and length(btrim("task_execution_operations"."admitted_run_id")) > 0 and "task_execution_operations"."admitted_run_id" is not null and "task_execution_operations"."dispatched_at" is not null and "task_execution_operations"."admitted_at" is not null and "task_execution_operations"."resolved_reason" is null and "task_execution_operations"."resolved_at" is null)
    or ("task_execution_operations"."phase" = 'resolved' and "task_execution_operations"."resolved_reason" = 'cancelled_before_dispatch' and "task_execution_operations"."resolved_reason" is not null and "task_execution_operations"."resolved_at" is not null and "task_execution_operations"."admitted_run_id" is null and "task_execution_operations"."dispatched_at" is null and "task_execution_operations"."admitted_at" is null))
);
--> statement-breakpoint
ALTER TABLE "task_execution_controls" ADD CONSTRAINT "task_execution_controls_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_controls" ADD CONSTRAINT "task_execution_controls_current_identity" FOREIGN KEY ("task_id","current_operation_id","coverage_epoch","revision") REFERENCES "public"."task_execution_operations"("task_id","id","coverage_epoch","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_operations" ADD CONSTRAINT "task_execution_operations_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "task_execution_operations_one_active" ON "task_execution_operations" USING btree ("task_id") WHERE "task_execution_operations"."phase" <> 'resolved';