ALTER TABLE "route_probe_history" ADD COLUMN "check_question" text;--> statement-breakpoint
ALTER TABLE "route_probe_history" ADD COLUMN "check_expected" text;--> statement-breakpoint
ALTER TABLE "route_probe_history" ADD COLUMN "check_answer" text;--> statement-breakpoint
ALTER TABLE "route_probe_history" ADD COLUMN "check_passed" boolean;--> statement-breakpoint
ALTER TABLE "route_probe_history" ADD COLUMN "self_identity" text;