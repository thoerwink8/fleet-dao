CREATE TABLE "acceptance_duties" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "acceptance_duties_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"task_id" uuid NOT NULL,
	"repo" text NOT NULL,
	"issue_number" integer NOT NULL,
	"pr_number" integer DEFAULT 0 NOT NULL,
	"head" text DEFAULT '' NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"items" text[] NOT NULL,
	"source" text DEFAULT 'cold_verify' NOT NULL,
	"merge_commit" text,
	"merged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	"settled_by" text,
	"settle_evidence" text,
	CONSTRAINT "acceptance_duties_task_pr_head_unique" UNIQUE("task_id","pr_number","head"),
	CONSTRAINT "acceptance_duties_issue_positive" CHECK ("acceptance_duties"."issue_number" > 0),
	CONSTRAINT "acceptance_duties_pr_nonneg" CHECK ("acceptance_duties"."pr_number" >= 0),
	CONSTRAINT "acceptance_duties_items_nonempty" CHECK (cardinality("acceptance_duties"."items") > 0),
	CONSTRAINT "acceptance_duties_source_known" CHECK ("acceptance_duties"."source" in ('cold_verify', 'coordination')),
	CONSTRAINT "acceptance_duties_settled_complete" CHECK (("acceptance_duties"."settled_at" is null and "acceptance_duties"."settled_by" is null and "acceptance_duties"."settle_evidence" is null) or ("acceptance_duties"."settled_at" is not null and "acceptance_duties"."settled_by" is not null and length("acceptance_duties"."settle_evidence") > 0))
);
--> statement-breakpoint
ALTER TABLE "acceptance_duties" ADD CONSTRAINT "acceptance_duties_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "acceptance_duties_open_idx" ON "acceptance_duties" USING btree ("task_id") WHERE "acceptance_duties"."settled_at" is null;