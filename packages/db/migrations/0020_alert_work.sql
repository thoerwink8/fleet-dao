CREATE TABLE "alert_silences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_kind" text NOT NULL,
	"match" text NOT NULL,
	"comment" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"expired_at" timestamp with time zone,
	"expired_by" text,
	"expire_note" text,
	CONSTRAINT "alert_silences_match_kind_known" CHECK ("alert_silences"."match_kind" in ('key', 'prefix')),
	CONSTRAINT "alert_silences_match_shape" CHECK (length("alert_silences"."match") between 1 and 300 and "alert_silences"."match" !~ '\s' and ("alert_silences"."match_kind" = 'key' or (length("alert_silences"."match") >= 4 and right("alert_silences"."match", 1) = ':'))),
	CONSTRAINT "alert_silences_comment_not_blank" CHECK (length(btrim("alert_silences"."comment")) > 0),
	CONSTRAINT "alert_silences_ends_after_created" CHECK ("alert_silences"."ends_at" > "alert_silences"."created_at"),
	CONSTRAINT "alert_silences_at_most_7_days" CHECK ("alert_silences"."ends_at" <= "alert_silences"."created_at" + interval '7 days'),
	CONSTRAINT "alert_silences_expired_shape" CHECK (("alert_silences"."expired_at" is null) = ("alert_silences"."expired_by" is null) and ("alert_silences"."expired_at" is null) = ("alert_silences"."expire_note" is null))
);
--> statement-breakpoint
CREATE TABLE "alert_work" (
	"notification_id" uuid PRIMARY KEY NOT NULL,
	"repo_id" uuid NOT NULL,
	"issue_number" integer NOT NULL,
	"source" text NOT NULL,
	"linked_by" text NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text,
	CONSTRAINT "alert_work_issue_number_positive" CHECK ("alert_work"."issue_number" > 0),
	CONSTRAINT "alert_work_source_known" CHECK ("alert_work"."source" in ('engine', 'claim'))
);
--> statement-breakpoint
ALTER TABLE "pull_requests" ADD COLUMN "opened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD COLUMN "merged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD COLUMN "merge_sha" text;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD COLUMN "issue_refs" integer[] DEFAULT '{}'::integer[] NOT NULL;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD COLUMN "alert_refs" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "alert_work" ADD CONSTRAINT "alert_work_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_work" ADD CONSTRAINT "alert_work_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alert_silences_live_idx" ON "alert_silences" USING btree ("ends_at") WHERE "alert_silences"."expired_at" is null;--> statement-breakpoint
CREATE INDEX "alert_work_issue_idx" ON "alert_work" USING btree ("repo_id","issue_number");--> statement-breakpoint
CREATE INDEX "pull_requests_issue_refs_idx" ON "pull_requests" USING gin ("issue_refs");--> statement-breakpoint
CREATE INDEX "pull_requests_alert_refs_idx" ON "pull_requests" USING gin ("alert_refs");--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_merge_shape" CHECK ("pull_requests"."merge_sha" is null or "pull_requests"."merge_sha" ~ '^[0-9a-f]{40}$');