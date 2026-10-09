CREATE TABLE "feishu_usage_reports" (
	"report_id" text PRIMARY KEY NOT NULL,
	"month" text NOT NULL,
	"calls" integer NOT NULL,
	"applied_at" timestamp with time zone NOT NULL,
	CONSTRAINT "feishu_usage_reports_id_len" CHECK (char_length("feishu_usage_reports"."report_id") between 1 and 80),
	CONSTRAINT "feishu_usage_reports_month" CHECK ("feishu_usage_reports"."month" ~ '^[0-9]{4}-[0-9]{2}$'),
	CONSTRAINT "feishu_usage_reports_calls" CHECK ("feishu_usage_reports"."calls" >= 0)
);
