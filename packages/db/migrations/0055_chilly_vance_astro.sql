ALTER TABLE "routes" ADD COLUMN "suspected_swap" boolean;--> statement-breakpoint
ALTER TABLE "routes" ADD COLUMN "probe_trigger" text;--> statement-breakpoint
ALTER TABLE "route_probe_history" ADD COLUMN "check_old_answer" text;--> statement-breakpoint
ALTER TABLE "routes" ADD CONSTRAINT "routes_probe_trigger_known" CHECK ("routes"."probe_trigger" is null or "routes"."probe_trigger" in ('scheduled', 'dispatch', 'manual', 'break', 'org-switch'));