-- 额度窗按上游原名（label）存，主键改成 (pool_id, label)；加单位、读法、原状态字、上游不再报的时刻；窗口类型加 other；
-- 池上加模型组成员表和最近一次读成的时刻。
-- drizzle-kit 生成的顺序在已有数据的库上跑不通（先建主键后加列、NOT NULL 列没有默认值），这里改成：
-- 先加可空列 → 给旧行补值 → 再设 NOT NULL → 最后换主键。旧行补的值只是占位（source = legacy），下一次读数就会覆盖。
CREATE TYPE "public"."quota_unit" AS ENUM('percent', 'usd', 'tokens', 'points');--> statement-breakpoint
ALTER TYPE "public"."quota_window_kind" ADD VALUE 'other';--> statement-breakpoint
ALTER TABLE "pools" ADD COLUMN "scope_models" jsonb;--> statement-breakpoint
ALTER TABLE "pools" ADD COLUMN "last_read_ok_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pools" ADD CONSTRAINT "pools_scope_models_shape" CHECK ("pools"."scope_models" is null or (jsonb_typeof("pools"."scope_models") = 'object' and not jsonb_path_exists("pools"."scope_models", '$.* ? (!(@.in.type() == "array" || @.notIn.type() == "array") || (exists(@.in) && exists(@.notIn)))') and not jsonb_path_exists("pools"."scope_models", '$.*.*[*] ? (@.type() != "string")')));--> statement-breakpoint
ALTER TABLE "quota_windows" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "quota_windows" ADD COLUMN "unit" "quota_unit";--> statement-breakpoint
ALTER TABLE "quota_windows" ADD COLUMN "status_raw" text;--> statement-breakpoint
ALTER TABLE "quota_windows" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "quota_windows" ADD COLUMN "stale_since" timestamp with time zone;--> statement-breakpoint
-- 旧主键是 (pool_id, window, scope)，旧检查保证只有 7d_model 带组名，所以这样补出来的 label 在同一池里不会撞。
UPDATE "quota_windows" SET
  "label" = CASE WHEN "window" = '7d_model' THEN '7d_' || "scope" ELSE "window"::text END,
  "unit" = (CASE
    WHEN "window" IN ('month_usd', 'period_usd') THEN 'usd'
    WHEN "utilization" IS NOT NULL AND "used" IS NULL THEN 'percent'
    ELSE 'points'
  END)::"quota_unit",
  "source" = 'legacy';--> statement-breakpoint
-- 旧行都是读成时写的：池的最近读成时刻取它窗口里最新的读数时刻；没有窗口的池留空（= 从没读成过）。
UPDATE "pools" SET "last_read_ok_at" = w."read_at"
  FROM (SELECT "pool_id", max("read_at") AS "read_at" FROM "quota_windows" GROUP BY "pool_id") AS w
  WHERE w."pool_id" = "pools"."id";--> statement-breakpoint
ALTER TABLE "quota_windows" ALTER COLUMN "label" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "quota_windows" ALTER COLUMN "unit" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "quota_windows" ALTER COLUMN "source" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "quota_windows" DROP CONSTRAINT "quota_windows_model_scope";--> statement-breakpoint
ALTER TABLE "quota_windows" DROP CONSTRAINT "quota_windows_pool_id_window_scope_pk";--> statement-breakpoint
ALTER TABLE "quota_windows" ADD CONSTRAINT "quota_windows_pool_id_label_pk" PRIMARY KEY("pool_id","label");--> statement-breakpoint
ALTER TABLE "quota_windows" ADD CONSTRAINT "quota_windows_label_nonempty" CHECK ("quota_windows"."label" <> '');--> statement-breakpoint
ALTER TABLE "quota_windows" ADD CONSTRAINT "quota_windows_source_nonempty" CHECK ("quota_windows"."source" <> '');--> statement-breakpoint
ALTER TABLE "quota_windows" ADD CONSTRAINT "quota_windows_model_scope" CHECK ("quota_windows"."window" <> '7d_model' or "quota_windows"."scope" <> '');--> statement-breakpoint
-- 池本身变了（最近读成时刻、到期日、成员表……）额度页也要刷新：按池报成 quota_windows，id 是池 id。
-- 读成了但上游一个窗口都没报时，只有这一条通知。写法照 0001：不写列名，先 DROP IF EXISTS。
DROP TRIGGER IF EXISTS pools_notify ON pools;
--> statement-breakpoint
CREATE TRIGGER pools_notify AFTER INSERT OR UPDATE OR DELETE ON pools
  FOR EACH ROW EXECUTE FUNCTION fleet_notify_change('id', 'quota_windows');
