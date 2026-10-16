CREATE TABLE "task_rounds" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "task_rounds_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"task_id" uuid NOT NULL,
	"workflow_id" text NOT NULL,
	"seq" integer NOT NULL,
	"round" integer NOT NULL,
	"outcome" text NOT NULL,
	"tier" text,
	"first_model" text,
	"added_lines" integer,
	"ended_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_rounds_workflow_seq_unique" UNIQUE("workflow_id","seq"),
	CONSTRAINT "task_rounds_outcome_known" CHECK ("task_rounds"."outcome" in ('merged', 'verify_rejected', 'ci_red', 'leftover', 'no_commit', 'push_conflict', 'merge_conflict', 'timeout', 'stopped', 'other')),
	CONSTRAINT "task_rounds_seq_positive" CHECK ("task_rounds"."seq" > 0),
	CONSTRAINT "task_rounds_round_nonneg" CHECK ("task_rounds"."round" >= 0),
	CONSTRAINT "task_rounds_added_lines_nonneg" CHECK ("task_rounds"."added_lines" is null or "task_rounds"."added_lines" >= 0)
);
--> statement-breakpoint
ALTER TABLE "task_rounds" ADD CONSTRAINT "task_rounds_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_rounds_ended_at_idx" ON "task_rounds" USING btree ("ended_at");