CREATE TYPE "public"."route_probe_state" AS ENUM('ok', 'failed', 'not_wired', 'skipped');--> statement-breakpoint
ALTER TABLE "routes" ADD COLUMN "probe_state" "route_probe_state";--> statement-breakpoint
ALTER TABLE "routes" ADD COLUMN "probed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "routes" ADD COLUMN "probe_detail" text;--> statement-breakpoint
ALTER TABLE "routes" ADD CONSTRAINT "routes_alive_needs_probe_ok" CHECK (not "routes"."alive" or coalesce("routes"."probe_state" = 'ok', false));--> statement-breakpoint
ALTER TABLE "routes" ADD CONSTRAINT "routes_probe_state_at_together" CHECK (("routes"."probe_state" is null) = ("routes"."probed_at" is null));--> statement-breakpoint
ALTER TABLE "routes" ADD CONSTRAINT "routes_probe_not_ok_has_detail" CHECK ("routes"."probe_state" is null or "routes"."probe_state" = 'ok' or coalesce("routes"."probe_detail", '') <> '');