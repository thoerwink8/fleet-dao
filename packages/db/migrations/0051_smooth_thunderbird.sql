CREATE TABLE "run_transcript" (
	"run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"tool" text,
	"ok" boolean,
	"meta" jsonb,
	CONSTRAINT "run_transcript_pk" PRIMARY KEY("run_id","seq"),
	CONSTRAINT "run_transcript_kind_known" CHECK ("run_transcript"."kind" in ('prompt', 'assistant', 'tool_call', 'tool_result', 'error', 'result', 'truncated')),
	CONSTRAINT "run_transcript_seq_nonneg" CHECK ("run_transcript"."seq" >= 0)
);
--> statement-breakpoint
ALTER TABLE "run_transcript" ADD CONSTRAINT "run_transcript_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;