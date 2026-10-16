ALTER TABLE "requests" DROP CONSTRAINT "requests_status_known";--> statement-breakpoint
ALTER TABLE "requests" DROP CONSTRAINT "requests_closed_shape";--> statement-breakpoint
ALTER TABLE "requests" DROP CONSTRAINT "requests_drop_has_reason";--> statement-breakpoint
ALTER TABLE "requests" DROP CONSTRAINT "requests_archive_only_closed";--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_status_known" CHECK ("requests"."status" in ('discussing', 'pending_decision', 'closed_do', 'closed_drop', 'idle_closed'));--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_closed_shape" CHECK (("requests"."status" in ('closed_do', 'closed_drop', 'idle_closed')) = ("requests"."closed_at" is not null));--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_drop_has_reason" CHECK ("requests"."status" not in ('closed_drop', 'idle_closed') or "requests"."close_reason" is not null);--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_archive_only_closed" CHECK ("requests"."archived_at" is null or "requests"."status" in ('closed_do', 'closed_drop', 'idle_closed'));