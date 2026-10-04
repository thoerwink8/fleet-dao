CREATE TABLE "intent_messages" (
	"message_id" text PRIMARY KEY NOT NULL,
	"intent_id" uuid NOT NULL,
	"chat_id" text NOT NULL,
	"thread_id" text,
	"parent_id" text,
	"sender_user_id" uuid NOT NULL,
	"sender_name" text NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"msg_type" text NOT NULL,
	"text" text NOT NULL,
	"raw_content" text NOT NULL,
	"content_hash" text NOT NULL,
	"at_bot" boolean NOT NULL,
	"forward_of" text,
	"forward_sender" text,
	"edited_at" timestamp with time zone,
	"edits" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"recalled_at" timestamp with time zone,
	CONSTRAINT "intent_messages_source_known" CHECK ("intent_messages"."source" in ('event', 'backfill')),
	CONSTRAINT "intent_messages_msg_type_length" CHECK (char_length("intent_messages"."msg_type") between 1 and 50),
	CONSTRAINT "intent_messages_forward_shape" CHECK ("intent_messages"."forward_sender" is null or "intent_messages"."forward_of" is not null),
	CONSTRAINT "intent_messages_edits_array" CHECK (jsonb_typeof("intent_messages"."edits") = 'array'),
	CONSTRAINT "intent_messages_edited_shape" CHECK (jsonb_array_length("intent_messages"."edits") = 0 or "intent_messages"."edited_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "intent_recalls" (
	"message_id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"recalled_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	CONSTRAINT "intent_recalls_source_known" CHECK ("intent_recalls"."source" in ('event', 'backfill'))
);
--> statement-breakpoint
CREATE TABLE "intents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seq" integer GENERATED ALWAYS AS IDENTITY (sequence name "intents_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"chat_id" text NOT NULL,
	"chat_kind" text NOT NULL,
	"thread_id" text,
	"status" text DEFAULT 'new' NOT NULL,
	"continues_intent_id" uuid,
	"revision" integer DEFAULT 1 NOT NULL,
	"first_message_id" text NOT NULL,
	"first_message_at" timestamp with time zone NOT NULL,
	"last_message_at" timestamp with time zone NOT NULL,
	"summary_text" text,
	"summary_by" text,
	"summary_at" timestamp with time zone,
	"summary_covers" integer,
	"links" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"drop_reason" text,
	"dropped_by" text,
	"dropped_at" timestamp with time zone,
	"card_rev" integer DEFAULT 1 NOT NULL,
	"card_shown_rev" integer,
	"card_message_id" text,
	"card_due_at" timestamp with time zone,
	"card_attempts" integer DEFAULT 0 NOT NULL,
	"card_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intents_seq_unique" UNIQUE("seq"),
	CONSTRAINT "intents_status_known" CHECK ("intents"."status" in ('new', 'linked', 'dropped')),
	CONSTRAINT "intents_chat_kind_known" CHECK ("intents"."chat_kind" in ('p2p', 'group')),
	CONSTRAINT "intents_revision_positive" CHECK ("intents"."revision" >= 1),
	CONSTRAINT "intents_message_order" CHECK ("intents"."first_message_at" <= "intents"."last_message_at"),
	CONSTRAINT "intents_summary_shape" CHECK (("intents"."summary_text" is null) = ("intents"."summary_by" is null) and ("intents"."summary_text" is null) = ("intents"."summary_at" is null) and ("intents"."summary_text" is null) = ("intents"."summary_covers" is null)),
	CONSTRAINT "intents_summary_length" CHECK ("intents"."summary_text" is null or char_length("intents"."summary_text") between 1 and 2000),
	CONSTRAINT "intents_summary_covers_nonneg" CHECK ("intents"."summary_covers" is null or "intents"."summary_covers" >= 0),
	CONSTRAINT "intents_links_array" CHECK (jsonb_typeof("intents"."links") = 'array'),
	CONSTRAINT "intents_linked_has_links" CHECK (("intents"."status" = 'linked') = (jsonb_array_length("intents"."links") > 0)),
	CONSTRAINT "intents_drop_shape" CHECK (("intents"."drop_reason" is null) = ("intents"."dropped_by" is null) and ("intents"."drop_reason" is null) = ("intents"."dropped_at" is null) and ("intents"."status" <> 'dropped' or "intents"."drop_reason" is not null)),
	CONSTRAINT "intents_card_rev_positive" CHECK ("intents"."card_rev" >= 1),
	CONSTRAINT "intents_card_shown_rev_range" CHECK ("intents"."card_shown_rev" is null or "intents"."card_shown_rev" between 1 and "intents"."card_rev"),
	CONSTRAINT "intents_card_attempts_nonneg" CHECK ("intents"."card_attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "intent_messages" ADD CONSTRAINT "intent_messages_intent_id_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."intents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intent_messages" ADD CONSTRAINT "intent_messages_sender_user_id_users_id_fk" FOREIGN KEY ("sender_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intents" ADD CONSTRAINT "intents_continues_intent_id_intents_id_fk" FOREIGN KEY ("continues_intent_id") REFERENCES "public"."intents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "intent_messages_intent_idx" ON "intent_messages" USING btree ("intent_id","sent_at");--> statement-breakpoint
CREATE INDEX "intent_messages_chat_idx" ON "intent_messages" USING btree ("chat_id","sent_at");--> statement-breakpoint
CREATE INDEX "intents_chat_thread_idx" ON "intents" USING btree ("chat_id","thread_id");--> statement-breakpoint
CREATE INDEX "intents_status_seq_idx" ON "intents" USING btree ("status","seq");--> statement-breakpoint
CREATE INDEX "intents_card_due_idx" ON "intents" USING btree ("card_due_at") WHERE "intents"."card_due_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "intents_card_message_unique" ON "intents" USING btree ("card_message_id") WHERE "intents"."card_message_id" is not null;