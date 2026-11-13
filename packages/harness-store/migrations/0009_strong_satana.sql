CREATE TABLE "fleet2"."ade_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"agent" text NOT NULL,
	"model" text NOT NULL,
	"prompt" text NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"session_id" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ade_schedules_status" CHECK ("fleet2"."ade_schedules"."status" in ('active', 'paused', 'firing', 'done', 'error'))
);
--> statement-breakpoint
CREATE INDEX "ade_schedules_due_idx" ON "fleet2"."ade_schedules" USING btree ("run_at","id") WHERE "fleet2"."ade_schedules"."status" = 'active';