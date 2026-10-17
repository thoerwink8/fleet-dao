ALTER TABLE "route_probe_history" ADD COLUMN "detail" text;--> statement-breakpoint
ALTER TABLE "route_probe_history" ADD COLUMN "quota_exhausted" boolean;--> statement-breakpoint
ALTER TABLE "route_probe_history" ADD COLUMN "resets_at" timestamp with time zone;