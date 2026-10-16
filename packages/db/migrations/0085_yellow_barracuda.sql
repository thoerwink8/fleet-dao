CREATE TABLE "task_flow_assignments" (
	"task_id" uuid PRIMARY KEY NOT NULL,
	"mode" text NOT NULL,
	"source" text NOT NULL,
	"stratum" text NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text,
	CONSTRAINT "task_flow_assignments_mode_known" CHECK ("task_flow_assignments"."mode" in ('three', 'full')),
	CONSTRAINT "task_flow_assignments_source_known" CHECK ("task_flow_assignments"."source" in ('label', 'hash', 'ineligible'))
);
--> statement-breakpoint
ALTER TABLE "task_rounds" ADD COLUMN "flow_mode" text;--> statement-breakpoint
ALTER TABLE "task_rounds" ADD COLUMN "verify_reject_class" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "flow_mode" text;--> statement-breakpoint
ALTER TABLE "task_flow_assignments" ADD CONSTRAINT "task_flow_assignments_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_rounds" ADD CONSTRAINT "task_rounds_flow_mode_known" CHECK ("task_rounds"."flow_mode" is null or "task_rounds"."flow_mode" in ('three', 'full'));--> statement-breakpoint
ALTER TABLE "task_rounds" ADD CONSTRAINT "task_rounds_verify_reject_class_known" CHECK ("task_rounds"."verify_reject_class" is null or "task_rounds"."verify_reject_class" in ('real_defect', 'verifier_false_reject', 'incomplete_spec', 'infra'));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_flow_mode_known" CHECK ("tasks"."flow_mode" is null or "tasks"."flow_mode" in ('three', 'full'));