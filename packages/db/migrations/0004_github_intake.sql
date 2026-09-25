-- 接活入口（#43）：收到的 GitHub 事件原文落库（一次投递一行，去重、重放都靠它）；仓加自动派活开关，已有的仓一律是关着的（空）。
CREATE TABLE "github_events" (
	"delivery_id" text PRIMARY KEY NOT NULL,
	"event" text NOT NULL,
	"action" text,
	"source" text NOT NULL,
	"repo" text,
	"version_key" text,
	"payload" jsonb NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"note" text,
	"attempts" integer DEFAULT 1 NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "github_events_status_known" CHECK ("github_events"."status" in ('processing', 'accepted', 'ignored', 'failed')),
	CONSTRAINT "github_events_source_known" CHECK ("github_events"."source" in ('webhook', 'poll', 'redelivery')),
	CONSTRAINT "github_events_reason_when_not_taken" CHECK ("github_events"."status" not in ('ignored', 'failed') or coalesce(length("github_events"."reason"), 0) > 0),
	CONSTRAINT "github_events_finished_iff_done" CHECK (("github_events"."status" = 'processing') = ("github_events"."finished_at" is null)),
	CONSTRAINT "github_events_attempts_positive" CHECK ("github_events"."attempts" > 0)
);
--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "auto_dispatch_since" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "github_events_version_key_idx" ON "github_events" USING btree ("version_key") WHERE "github_events"."version_key" is not null;--> statement-breakpoint
CREATE INDEX "github_events_unfinished_idx" ON "github_events" USING btree ("attempts","received_at") WHERE "github_events"."status" in ('processing', 'failed');