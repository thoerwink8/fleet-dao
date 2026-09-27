ALTER TYPE "public"."stage_kind" ADD VALUE 'verify' BEFORE 'research';--> statement-breakpoint
CREATE TABLE "verify_rounds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"round" integer NOT NULL,
	"head" text NOT NULL,
	"run_id" uuid NOT NULL,
	"route_id" text NOT NULL,
	"family" text NOT NULL,
	"author_families" text[] NOT NULL,
	"criteria" jsonb NOT NULL,
	"report" jsonb,
	"verdict" text NOT NULL,
	"invalid_why" text,
	"rebuttals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"final_verdict" text,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verify_rounds_round_positive" CHECK ("verify_rounds"."round" >= 1),
	CONSTRAINT "verify_rounds_verdict_known" CHECK ("verify_rounds"."verdict" in ('pass', 'block', 'invalid')),
	CONSTRAINT "verify_rounds_final_known" CHECK ("verify_rounds"."final_verdict" is null or "verify_rounds"."final_verdict" in ('pass', 'block')),
	CONSTRAINT "verify_rounds_invalid_shape" CHECK (("verify_rounds"."verdict" = 'invalid') = ("verify_rounds"."invalid_why" is not null) and ("verify_rounds"."verdict" = 'invalid') = ("verify_rounds"."final_verdict" is null) and ("verify_rounds"."verdict" = 'invalid' or "verify_rounds"."report" is not null)),
	CONSTRAINT "verify_rounds_pass_stays_pass" CHECK ("verify_rounds"."verdict" <> 'pass' or "verify_rounds"."final_verdict" = 'pass'),
	CONSTRAINT "verify_rounds_reasons_match" CHECK ("verify_rounds"."final_verdict" is null or jsonb_typeof("verify_rounds"."reasons") <> 'array' or ("verify_rounds"."final_verdict" = 'block') = (jsonb_array_length("verify_rounds"."reasons") > 0)),
	CONSTRAINT "verify_rounds_lists_are_arrays" CHECK (jsonb_typeof("verify_rounds"."criteria") = 'array' and jsonb_typeof("verify_rounds"."rebuttals") = 'array' and jsonb_typeof("verify_rounds"."reasons") = 'array' and jsonb_typeof("verify_rounds"."notes") = 'array'),
	CONSTRAINT "verify_rounds_authors_known" CHECK (cardinality("verify_rounds"."author_families") > 0)
);
--> statement-breakpoint
ALTER TABLE "verify_rounds" ADD CONSTRAINT "verify_rounds_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verify_rounds" ADD CONSTRAINT "verify_rounds_run_id_session_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."session_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verify_rounds" ADD CONSTRAINT "verify_rounds_route_id_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."routes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "verify_rounds_task_idx" ON "verify_rounds" USING btree ("task_id","created_at");