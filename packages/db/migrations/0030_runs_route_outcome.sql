ALTER TABLE "runs" ADD COLUMN "route_outcome" text;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_route_outcome_known" CHECK ("runs"."route_outcome" is null or "runs"."route_outcome" in ('ok', 'fail', 'neutral'));--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_route_outcome_after_end" CHECK ("runs"."route_outcome" is null or "runs"."ended_at" is not null);