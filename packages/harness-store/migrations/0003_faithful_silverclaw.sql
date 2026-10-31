CREATE TABLE "fleet2"."shadow_batch_items" (
	"batch_id" text NOT NULL,
	"repo" text NOT NULL,
	"issue" integer NOT NULL,
	"base_sha" text NOT NULL,
	"snapshot_at" timestamp with time zone NOT NULL,
	CONSTRAINT "shadow_batch_items_unique" UNIQUE("batch_id","repo","issue"),
	CONSTRAINT "shadow_batch_items_sha" CHECK ("fleet2"."shadow_batch_items"."base_sha" ~ '^[0-9a-f]{40}$')
);
--> statement-breakpoint
CREATE TABLE "fleet2"."shadow_compare" (
	"shadow_run_id" bigint PRIMARY KEY NOT NULL,
	"batch_id" text NOT NULL,
	"merged_pr" integer NOT NULL,
	"merged_sha" text NOT NULL,
	"score" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fleet2"."shadow_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"batch_id" text NOT NULL,
	"repo" text NOT NULL,
	"issue" integer NOT NULL,
	"base_sha" text NOT NULL,
	"verdict" text NOT NULL,
	"patch" text NOT NULL,
	"wall_ms" integer NOT NULL,
	"tokens" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shadow_runs_run_unique" UNIQUE("run_id"),
	CONSTRAINT "shadow_runs_verdict_known" CHECK ("fleet2"."shadow_runs"."verdict" in ('unverified', 'passed', 'failed', 'unknown'))
);
--> statement-breakpoint
CREATE INDEX "shadow_compare_batch_idx" ON "fleet2"."shadow_compare" USING btree ("batch_id","shadow_run_id");--> statement-breakpoint
CREATE INDEX "shadow_runs_batch_idx" ON "fleet2"."shadow_runs" USING btree ("batch_id","id");