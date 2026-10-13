ALTER TYPE "public"."stage_kind" ADD VALUE 'intake-chat';--> statement-breakpoint
CREATE TABLE "request_chats" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'idle' NOT NULL,
	"job" text,
	"queued_by" uuid,
	"queued_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"stop_requested_at" timestamp with time zone,
	"turns" integer DEFAULT 0 NOT NULL,
	"session_id" text,
	"route_id" text,
	"model_id" text,
	"workdir" text,
	"last_message_id" bigint,
	"last_turn_at" timestamp with time zone,
	"phase" text,
	"stream_text" text DEFAULT '' NOT NULL,
	"paused_why" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "request_chats_state_known" CHECK ("request_chats"."state" in ('idle', 'queued', 'running')),
	CONSTRAINT "request_chats_job_known" CHECK ("request_chats"."job" is null or "request_chats"."job" in ('reply', 'review')),
	CONSTRAINT "request_chats_phase_known" CHECK ("request_chats"."phase" is null or "request_chats"."phase" in ('thinking', 'reading_code', 'writing')),
	CONSTRAINT "request_chats_job_shape" CHECK (("request_chats"."state" = 'idle') = ("request_chats"."job" is null)),
	CONSTRAINT "request_chats_turns_nonneg" CHECK ("request_chats"."turns" >= 0)
);
--> statement-breakpoint
ALTER TABLE "request_messages" ADD COLUMN "card" jsonb;--> statement-breakpoint
ALTER TABLE "request_chats" ADD CONSTRAINT "request_chats_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_chats" ADD CONSTRAINT "request_chats_queued_by_users_id_fk" FOREIGN KEY ("queued_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "request_chats_state_idx" ON "request_chats" USING btree ("state");--> statement-breakpoint
ALTER TABLE "request_messages" ADD CONSTRAINT "request_messages_card_object" CHECK ("request_messages"."card" is null or jsonb_typeof("request_messages"."card") = 'object');