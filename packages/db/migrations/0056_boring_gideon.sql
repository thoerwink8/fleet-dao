-- 删掉按需探测 on_demand（#1798 片 8，#1843）：把剩下的 on_demand 行改成 skipped（原文写明为什么），再重建枚举。
-- 陷阱：从空库建库时所有迁移在同一个事务里跑，0052 刚 ADD VALUE 的 'on_demand' 在同一事务里不能当枚举值用
-- （真 Postgres 报 55P04 unsafe use of new value，PGlite 不查）。所以列还是枚举类型时这里不写任何枚举字面量：
-- 先摘约束、把列转成 text，在 text 上改写，再重建类型、转回去、装回约束。
-- 两条检查约束拿 probe_state 和 'ok' 比，列转 text 时比不了，先摘下；routes_probe_state_at_together 只判空，不用摘。
ALTER TABLE "routes" DROP CONSTRAINT "routes_alive_needs_probe_ok";--> statement-breakpoint
ALTER TABLE "routes" DROP CONSTRAINT "routes_probe_not_ok_has_detail";--> statement-breakpoint
ALTER TABLE "routes" ALTER COLUMN "probe_state" SET DATA TYPE text;--> statement-breakpoint
-- 只改 on_demand 行：probed_at 不动（同空同有照旧满足），alive 本来就是 false（只有 ok 能在线）。
UPDATE "routes" SET "probe_state" = 'skipped', "probe_detail" = '改版后等下一轮探' WHERE "probe_state" = 'on_demand';--> statement-breakpoint
DROP TYPE "public"."route_probe_state";--> statement-breakpoint
CREATE TYPE "public"."route_probe_state" AS ENUM('ok', 'failed', 'not_wired', 'skipped');--> statement-breakpoint
ALTER TABLE "routes" ALTER COLUMN "probe_state" SET DATA TYPE "public"."route_probe_state" USING "probe_state"::"public"."route_probe_state";--> statement-breakpoint
ALTER TABLE "routes" ADD CONSTRAINT "routes_alive_needs_probe_ok" CHECK (not "routes"."alive" or coalesce("routes"."probe_state" = 'ok', false));--> statement-breakpoint
ALTER TABLE "routes" ADD CONSTRAINT "routes_probe_not_ok_has_detail" CHECK ("routes"."probe_state" is null or "routes"."probe_state" = 'ok' or coalesce("routes"."probe_detail", '') <> '');
