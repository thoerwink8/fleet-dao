CREATE TABLE "request_messages" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "request_messages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"request_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"author_id" uuid,
	"channel" text,
	"body" text NOT NULL,
	"mentions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"draft_patch" jsonb,
	"github_comment_ref" text,
	"answer_state" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "request_messages_kind_known" CHECK ("request_messages"."kind" in ('human', 'commander', 'system', 'engine_ask', 'review')),
	CONSTRAINT "request_messages_channel_known" CHECK ("request_messages"."channel" is null or "request_messages"."channel" in ('web', 'mobile')),
	CONSTRAINT "request_messages_answer_state_known" CHECK ("request_messages"."answer_state" is null or "request_messages"."answer_state" in ('pending', 'written', 'failed')),
	CONSTRAINT "request_messages_human_shape" CHECK (("request_messages"."kind" = 'human') = ("request_messages"."author_id" is not null) and ("request_messages"."kind" <> 'human' or "request_messages"."channel" is not null)),
	CONSTRAINT "request_messages_body_length" CHECK (char_length("request_messages"."body") between 1 and 20000),
	CONSTRAINT "request_messages_mentions_array" CHECK (jsonb_typeof("request_messages"."mentions") = 'array')
);
--> statement-breakpoint
CREATE TABLE "request_user_state" (
	"request_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"pinned_at" timestamp with time zone,
	"last_read_message_id" bigint,
	CONSTRAINT "request_user_state_request_id_user_id_pk" PRIMARY KEY("request_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" integer GENERATED ALWAYS AS IDENTITY (sequence name "requests_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"repo_id" uuid NOT NULL,
	"initiator_id" uuid NOT NULL,
	"status" text DEFAULT 'discussing' NOT NULL,
	"decider_id" uuid,
	"draft_json" jsonb NOT NULL,
	"draft_version" integer DEFAULT 1 NOT NULL,
	"human_edited_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"issue_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"continues_request_id" uuid,
	"first_submitted_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"close_reason" text,
	"archived_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone NOT NULL,
	"model_choice" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "requests_seq_unique" UNIQUE("seq"),
	CONSTRAINT "requests_status_known" CHECK ("requests"."status" in ('discussing', 'pending_decision', 'closed_do', 'closed_drop')),
	CONSTRAINT "requests_draft_version_positive" CHECK ("requests"."draft_version" >= 1),
	CONSTRAINT "requests_draft_object" CHECK (jsonb_typeof("requests"."draft_json") = 'object'),
	CONSTRAINT "requests_human_edited_array" CHECK (jsonb_typeof("requests"."human_edited_fields") = 'array'),
	CONSTRAINT "requests_issue_refs_array" CHECK (jsonb_typeof("requests"."issue_refs") = 'array'),
	CONSTRAINT "requests_closed_shape" CHECK (("requests"."status" in ('closed_do', 'closed_drop')) = ("requests"."closed_at" is not null)),
	CONSTRAINT "requests_drop_has_reason" CHECK ("requests"."status" <> 'closed_drop' or "requests"."close_reason" is not null),
	CONSTRAINT "requests_decider_when_decided" CHECK ("requests"."status" not in ('pending_decision', 'closed_do') or "requests"."decider_id" is not null),
	CONSTRAINT "requests_archive_only_closed" CHECK ("requests"."archived_at" is null or "requests"."status" in ('closed_do', 'closed_drop')),
	CONSTRAINT "requests_close_reason_length" CHECK ("requests"."close_reason" is null or char_length("requests"."close_reason") between 1 and 500)
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "decides_requests" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "request_messages" ADD CONSTRAINT "request_messages_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_messages" ADD CONSTRAINT "request_messages_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_user_state" ADD CONSTRAINT "request_user_state_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_user_state" ADD CONSTRAINT "request_user_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_initiator_id_users_id_fk" FOREIGN KEY ("initiator_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_decider_id_users_id_fk" FOREIGN KEY ("decider_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_continues_request_id_requests_id_fk" FOREIGN KEY ("continues_request_id") REFERENCES "public"."requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "request_messages_request_idx" ON "request_messages" USING btree ("request_id","id");--> statement-breakpoint
CREATE INDEX "requests_repo_idx" ON "requests" USING btree ("repo_id");--> statement-breakpoint
CREATE INDEX "requests_initiator_idx" ON "requests" USING btree ("initiator_id");--> statement-breakpoint
CREATE INDEX "requests_activity_idx" ON "requests" USING btree ("last_activity_at");--> statement-breakpoint
CREATE INDEX "requests_deleted_idx" ON "requests" USING btree ("deleted_at") WHERE "requests"."deleted_at" is not null;--> statement-breakpoint
-- 拍板人（#2049）：能登驾驶舱的都是 founder，分不出创始人和合伙人。最早建的、在用的那位是创始人（合伙人是后来加的），设成拍板人。
-- 只在还没有任何拍板人时设：重跑不会把已经改过的设回去。
UPDATE "users" SET "decides_requests" = true WHERE "id" = (SELECT "id" FROM "users" WHERE "role" = 'founder' AND "active" ORDER BY "created_at", "id" LIMIT 1) AND NOT EXISTS (SELECT 1 FROM "users" WHERE "decides_requests");