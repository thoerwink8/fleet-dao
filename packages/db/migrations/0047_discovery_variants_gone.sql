ALTER TABLE "routes" DROP CONSTRAINT "routes_pool_model_host_unique";--> statement-breakpoint
ALTER TABLE "routes" ADD COLUMN "variant_effort" text;--> statement-breakpoint
ALTER TABLE "routes" ADD COLUMN "variant_fast" boolean;--> statement-breakpoint
ALTER TABLE "routes" ADD COLUMN "variant_thinking" boolean;--> statement-breakpoint
ALTER TABLE "routes" ADD COLUMN "variant_context" text;--> statement-breakpoint
ALTER TABLE "routes" ADD COLUMN "gone_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "routes" ADD CONSTRAINT "routes_pool_model_host_unique" UNIQUE NULLS NOT DISTINCT("pool_id","model_id","host_id","upstream_model");--> statement-breakpoint
ALTER TABLE "routes" ADD CONSTRAINT "routes_variant_effort_known" CHECK ("routes"."variant_effort" is null or "routes"."variant_effort" in ('low', 'medium', 'high', 'xhigh', 'max'));--> statement-breakpoint
ALTER TABLE "routes" ADD CONSTRAINT "routes_variant_context_nonempty" CHECK ("routes"."variant_context" is null or length(btrim("routes"."variant_context")) > 0);