CREATE TABLE "fleet2"."publish_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"batch_id" text NOT NULL,
	"repo" text NOT NULL,
	"issue" integer NOT NULL,
	"base_sha" text NOT NULL,
	"fencing" bigint NOT NULL,
	"model" text NOT NULL,
	"title" text NOT NULL,
	"verdict" text NOT NULL,
	"patch" text NOT NULL,
	"wall_ms" integer NOT NULL,
	"branch" text NOT NULL,
	"state" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "publish_runs_run_unique" UNIQUE("run_id"),
	CONSTRAINT "publish_runs_verdict_known" CHECK ("fleet2"."publish_runs"."verdict" in ('unverified', 'passed', 'failed', 'unknown')),
	CONSTRAINT "publish_runs_state_known" CHECK ("fleet2"."publish_runs"."state" in ('ready', 'held', 'empty', 'released'))
);
--> statement-breakpoint
CREATE TABLE "fleet2"."real_batch_items" (
	"batch_id" text NOT NULL,
	"repo" text NOT NULL,
	"issue" integer NOT NULL,
	"base_sha" text NOT NULL,
	"snapshot_at" timestamp with time zone NOT NULL,
	CONSTRAINT "real_batch_items_unique" UNIQUE("batch_id","repo","issue"),
	CONSTRAINT "real_batch_items_sha" CHECK ("fleet2"."real_batch_items"."base_sha" ~ '^[0-9a-f]{40}$')
);
--> statement-breakpoint
CREATE INDEX "publish_runs_task_idx" ON "fleet2"."publish_runs" USING btree ("repo","issue","id");--> statement-breakpoint
CREATE INDEX "publish_runs_batch_idx" ON "fleet2"."publish_runs" USING btree ("batch_id","repo","issue");--> statement-breakpoint
CREATE INDEX "real_batch_items_task_idx" ON "fleet2"."real_batch_items" USING btree ("repo","issue","snapshot_at");--> statement-breakpoint
CREATE INDEX "outbox_task_idx" ON "fleet2"."outbox" USING btree ("repo","issue","id");