-- 删掉按需探测 on_demand（#1798 片 8，#1843）。先把剩下的 on_demand 行改成 skipped（原文写明为什么），再重建枚举。
-- 只改 on_demand 行：probed_at 不动（同空同有的约束照旧满足），alive 本来就是 false（只有 ok 能在线）。
UPDATE "routes" SET "probe_state" = 'skipped', "probe_detail" = '改版后等下一轮探' WHERE "probe_state" = 'on_demand';--> statement-breakpoint
-- 两条检查约束拿 probe_state 和 'ok'（枚举字面量）比：列临时改成 text 时比不了，先摘下，换完类型原样装回。
ALTER TABLE "routes" DROP CONSTRAINT "routes_alive_needs_probe_ok";--> statement-breakpoint
ALTER TABLE "routes" DROP CONSTRAINT "routes_probe_not_ok_has_detail";--> statement-breakpoint
ALTER TABLE "routes" ALTER COLUMN "probe_state" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."route_probe_state";--> statement-breakpoint
CREATE TYPE "public"."route_probe_state" AS ENUM('ok', 'failed', 'not_wired', 'skipped');--> statement-breakpoint
ALTER TABLE "routes" ALTER COLUMN "probe_state" SET DATA TYPE "public"."route_probe_state" USING "probe_state"::"public"."route_probe_state";--> statement-breakpoint
ALTER TABLE "routes" ADD CONSTRAINT "routes_alive_needs_probe_ok" CHECK (not "routes"."alive" or coalesce("routes"."probe_state" = 'ok', false));--> statement-breakpoint
ALTER TABLE "routes" ADD CONSTRAINT "routes_probe_not_ok_has_detail" CHECK ("routes"."probe_state" is null or "routes"."probe_state" = 'ok' or coalesce("routes"."probe_detail", '') <> '');
