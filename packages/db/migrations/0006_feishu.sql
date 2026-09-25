CREATE TABLE "feishu_cards" (
	"message_id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"kind" text NOT NULL,
	"task_id" text,
	"ask_id" text,
	"draft_id" text,
	"notification_id" text,
	"outbox_id" text,
	"sent_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feishu_cards_kind_known" CHECK ("feishu_cards"."kind" in ('draft', 'progress', 'board', 'list', 'answer', 'decision', 'alert', 'daily', 'follow', 'ask'))
);
--> statement-breakpoint
CREATE TABLE "feishu_drafts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"source_message_id" text NOT NULL,
	"chat_type" text NOT NULL,
	"raw_text" text NOT NULL,
	"understanding" text NOT NULL,
	"unsure" boolean NOT NULL,
	"repo_id" uuid,
	"proposed_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_by" uuid,
	"confirmed_at" timestamp with time zone,
	"task_id" uuid,
	"open_attempts" integer DEFAULT 0 NOT NULL,
	"open_error" text,
	"open_tried_at" timestamp with time zone,
	CONSTRAINT "feishu_drafts_source_message_id_unique" UNIQUE("source_message_id"),
	CONSTRAINT "feishu_drafts_status_known" CHECK ("feishu_drafts"."status" in ('open', 'confirmed')),
	CONSTRAINT "feishu_drafts_chat_type_known" CHECK ("feishu_drafts"."chat_type" in ('p2p', 'group')),
	CONSTRAINT "feishu_drafts_revision_positive" CHECK ("feishu_drafts"."revision" >= 1),
	CONSTRAINT "feishu_drafts_understanding_length" CHECK (char_length("feishu_drafts"."understanding") between 1 and 1000),
	CONSTRAINT "feishu_drafts_confirm_shape" CHECK (("feishu_drafts"."status" = 'confirmed') = ("feishu_drafts"."confirmed_by" is not null) and ("feishu_drafts"."status" = 'confirmed') = ("feishu_drafts"."confirmed_at" is not null) and ("feishu_drafts"."status" <> 'confirmed' or "feishu_drafts"."repo_id" is not null)),
	CONSTRAINT "feishu_drafts_task_needs_confirm" CHECK ("feishu_drafts"."task_id" is null or "feishu_drafts"."status" = 'confirmed'),
	CONSTRAINT "feishu_drafts_open_attempts_nonneg" CHECK ("feishu_drafts"."open_attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "feishu_follows" (
	"task_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"following" boolean NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feishu_follows_task_id_user_id_pk" PRIMARY KEY("task_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "feishu_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"revision" integer NOT NULL,
	"fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ack_revision" integer,
	"ack_status" text,
	"ack_reason" text,
	"acked_at" timestamp with time zone,
	"hold_until" timestamp with time zone,
	"failures" integer DEFAULT 0 NOT NULL,
	"delivered_message_id" text,
	"delivered_chat_id" text,
	"delivered_at" timestamp with time zone,
	"delivered_revision" integer,
	CONSTRAINT "feishu_outbox_revision_positive" CHECK ("feishu_outbox"."revision" >= 1),
	CONSTRAINT "feishu_outbox_ack_status_known" CHECK ("feishu_outbox"."ack_status" is null or "feishu_outbox"."ack_status" in ('sent', 'updated', 'deferred', 'dropped', 'failed')),
	CONSTRAINT "feishu_outbox_ack_shape" CHECK (("feishu_outbox"."ack_revision" is null) = ("feishu_outbox"."ack_status" is null) and ("feishu_outbox"."ack_revision" is null) = ("feishu_outbox"."acked_at" is null) and ("feishu_outbox"."ack_revision" is null or "feishu_outbox"."ack_revision" between 1 and "feishu_outbox"."revision")),
	CONSTRAINT "feishu_outbox_hold_only_when_waiting" CHECK ("feishu_outbox"."hold_until" is null or "feishu_outbox"."ack_status" in ('deferred', 'failed')),
	CONSTRAINT "feishu_outbox_delivered_shape" CHECK (("feishu_outbox"."delivered_message_id" is null) = ("feishu_outbox"."delivered_chat_id" is null) and ("feishu_outbox"."delivered_message_id" is null) = ("feishu_outbox"."delivered_at" is null)),
	CONSTRAINT "feishu_outbox_failures_nonneg" CHECK ("feishu_outbox"."failures" >= 0)
);
--> statement-breakpoint
ALTER TABLE "feishu_drafts" ADD CONSTRAINT "feishu_drafts_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feishu_drafts" ADD CONSTRAINT "feishu_drafts_proposed_by_users_id_fk" FOREIGN KEY ("proposed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feishu_drafts" ADD CONSTRAINT "feishu_drafts_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feishu_drafts" ADD CONSTRAINT "feishu_drafts_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feishu_follows" ADD CONSTRAINT "feishu_follows_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feishu_follows" ADD CONSTRAINT "feishu_follows_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feishu_cards_draft_idx" ON "feishu_cards" USING btree ("draft_id","sent_at");--> statement-breakpoint
CREATE INDEX "feishu_cards_outbox_idx" ON "feishu_cards" USING btree ("outbox_id","sent_at");--> statement-breakpoint
CREATE INDEX "feishu_cards_kind_idx" ON "feishu_cards" USING btree ("kind","sent_at");--> statement-breakpoint
CREATE INDEX "feishu_drafts_to_open_idx" ON "feishu_drafts" USING btree ("confirmed_at") WHERE "feishu_drafts"."status" = 'confirmed' and "feishu_drafts"."task_id" is null;