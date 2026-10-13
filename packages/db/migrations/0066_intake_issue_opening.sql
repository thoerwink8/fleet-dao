CREATE TABLE "request_issue_openings" (
	"request_id" uuid NOT NULL,
	"draft_version" integer NOT NULL,
	"state" text NOT NULL,
	"requested_by" uuid NOT NULL,
	"opened_by" uuid NOT NULL,
	"issue_number" integer,
	"issue_url" text,
	"error" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "request_issue_openings_request_id_draft_version_pk" PRIMARY KEY("request_id","draft_version"),
	CONSTRAINT "request_issue_openings_state_known" CHECK ("request_issue_openings"."state" in ('opening', 'opened', 'failed')),
	CONSTRAINT "request_issue_openings_version_positive" CHECK ("request_issue_openings"."draft_version" >= 1),
	CONSTRAINT "request_issue_openings_opened_shape" CHECK (("request_issue_openings"."state" = 'opened') = ("request_issue_openings"."issue_number" is not null and "request_issue_openings"."issue_url" is not null)),
	CONSTRAINT "request_issue_openings_failed_has_error" CHECK ("request_issue_openings"."state" <> 'failed' or ("request_issue_openings"."error" is not null and char_length("request_issue_openings"."error") > 0))
);
--> statement-breakpoint
ALTER TABLE "request_messages" ADD COLUMN "answer_text" text;--> statement-breakpoint
ALTER TABLE "request_messages" ADD COLUMN "answer_error" text;--> statement-breakpoint
ALTER TABLE "request_messages" ADD COLUMN "answered_by" uuid;--> statement-breakpoint
ALTER TABLE "request_messages" ADD COLUMN "answered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "request_issue_openings" ADD CONSTRAINT "request_issue_openings_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_issue_openings" ADD CONSTRAINT "request_issue_openings_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_issue_openings" ADD CONSTRAINT "request_issue_openings_opened_by_users_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_messages" ADD CONSTRAINT "request_messages_answered_by_users_id_fk" FOREIGN KEY ("answered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "request_messages_comment_unique" ON "request_messages" USING btree ("request_id","github_comment_ref") WHERE "request_messages"."github_comment_ref" is not null;--> statement-breakpoint
ALTER TABLE "request_messages" ADD CONSTRAINT "request_messages_engine_ask_shape" CHECK (("request_messages"."kind" = 'engine_ask') = ("request_messages"."github_comment_ref" is not null) and ("request_messages"."kind" = 'engine_ask') = ("request_messages"."answer_state" is not null));--> statement-breakpoint
ALTER TABLE "request_messages" ADD CONSTRAINT "request_messages_answer_only_on_ask" CHECK ("request_messages"."kind" = 'engine_ask' or ("request_messages"."answer_text" is null and "request_messages"."answer_error" is null and "request_messages"."answered_by" is null and "request_messages"."answered_at" is null));
--> statement-breakpoint
-- 需求（requests）进实时名单：shared 的 REALTIME_TABLES 加了 requests，id 报需求号（seq），页面按号重读那条需求。
-- 对话里追加消息（进度卡、引擎提问）时同一事务里也会改 requests.last_activity_at，所以只在这一张表上装触发器；写法照 0035。
CREATE TRIGGER requests_notify AFTER INSERT OR UPDATE OR DELETE ON requests
  FOR EACH ROW EXECUTE FUNCTION fleet_notify_change('seq');
