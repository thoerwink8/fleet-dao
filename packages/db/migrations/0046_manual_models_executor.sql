ALTER TABLE "routes" ADD COLUMN "executor" text;--> statement-breakpoint
ALTER TABLE "channel_seen_models" ADD COLUMN "source" text DEFAULT '名册' NOT NULL;--> statement-breakpoint
ALTER TABLE "routes" ADD CONSTRAINT "routes_executor_nonempty" CHECK ("routes"."executor" is null or length(btrim("routes"."executor")) > 0);--> statement-breakpoint
ALTER TABLE "channel_seen_models" ADD CONSTRAINT "channel_seen_models_source_known" CHECK ("channel_seen_models"."source" in ('名册', '手工'));