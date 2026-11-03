CREATE TABLE "fleet2"."session_worker_state" (
	"stream_id" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"deadline" timestamp with time zone,
	"tail" jsonb NOT NULL,
	"head_seq" integer NOT NULL,
	"last_event_id" bigint NOT NULL,
	CONSTRAINT "session_worker_state_known" CHECK ("fleet2"."session_worker_state"."state" in ('stuck', 'running', 'waiting', 'done'))
);
--> statement-breakpoint
CREATE TABLE "fleet2"."worker_state_counts" (
	"state" text PRIMARY KEY NOT NULL,
	"n" integer NOT NULL,
	CONSTRAINT "worker_state_counts_known" CHECK ("fleet2"."worker_state_counts"."state" in ('stuck', 'running', 'waiting', 'done')),
	CONSTRAINT "worker_state_counts_nonneg" CHECK ("fleet2"."worker_state_counts"."n" >= 0)
);
--> statement-breakpoint
CREATE TABLE "fleet2"."worker_state_meta" (
	"id" integer PRIMARY KEY NOT NULL,
	"next_deadline" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "session_worker_state_deadline_idx" ON "fleet2"."session_worker_state" USING btree ("deadline") WHERE "fleet2"."session_worker_state"."state" = 'running' and "fleet2"."session_worker_state"."deadline" is not null;