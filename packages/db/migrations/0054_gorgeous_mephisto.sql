ALTER TABLE "channels" ADD COLUMN "identity_check" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "routes" ADD COLUMN "probe_tier" text;--> statement-breakpoint
ALTER TABLE "routes" ADD COLUMN "probe_next_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "routes" ADD COLUMN "probe_fail_streak" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "routes" ADD COLUMN "probe_kind" text;--> statement-breakpoint
ALTER TABLE "route_probe_history" ADD COLUMN "kind" text;--> statement-breakpoint
ALTER TABLE "route_probe_history" ADD COLUMN "trigger" text;--> statement-breakpoint
ALTER TABLE "routes" ADD CONSTRAINT "routes_probe_tier_known" CHECK ("routes"."probe_tier" is null or "routes"."probe_tier" in ('active', 'idle', 'unused'));--> statement-breakpoint
ALTER TABLE "routes" ADD CONSTRAINT "routes_probe_fail_streak_nonneg" CHECK ("routes"."probe_fail_streak" >= 0);--> statement-breakpoint
ALTER TABLE "routes" ADD CONSTRAINT "routes_probe_kind_known" CHECK ("routes"."probe_kind" is null or "routes"."probe_kind" in ('ping', 'identity'));--> statement-breakpoint
ALTER TABLE "route_probe_history" ADD CONSTRAINT "route_probe_history_kind_known" CHECK ("route_probe_history"."kind" is null or "route_probe_history"."kind" in ('ping', 'identity'));--> statement-breakpoint
ALTER TABLE "route_probe_history" ADD CONSTRAINT "route_probe_history_trigger_known" CHECK ("route_probe_history"."trigger" is null or "route_probe_history"."trigger" in ('scheduled', 'dispatch', 'manual', 'break', 'org-switch'));--> statement-breakpoint
-- 从 probe_detail「连着不通 N 次」回填 probe_fail_streak（#1798 片 2）；认不出的留默认 0。
UPDATE "routes"
SET "probe_fail_streak" = COALESCE(
  (regexp_match("probe_detail", '连着不通[[:space:]]*([0-9]+)[[:space:]]*次'))[1]::integer,
  0
);
