CREATE TABLE "feishu_joins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" text NOT NULL,
	"open_id_tail" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	CONSTRAINT "feishu_joins_tail_len" CHECK (char_length("feishu_joins"."open_id_tail") = 4),
	CONSTRAINT "feishu_joins_reason_len" CHECK (char_length("feishu_joins"."reason") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "feishu_rejections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" text NOT NULL,
	"open_id_tail" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	CONSTRAINT "feishu_rejections_tail_len" CHECK (char_length("feishu_rejections"."open_id_tail") = 4),
	CONSTRAINT "feishu_rejections_reason_len" CHECK (char_length("feishu_rejections"."reason") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "feishu_usage_months" (
	"month" text PRIMARY KEY NOT NULL,
	"calls" integer NOT NULL,
	CONSTRAINT "feishu_usage_months_shape" CHECK ("feishu_usage_months"."month" ~ '^[0-9]{4}-[0-9]{2}$'),
	CONSTRAINT "feishu_usage_months_calls" CHECK ("feishu_usage_months"."calls" >= 0)
);
