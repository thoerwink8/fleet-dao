-- 目录装载器（src/catalog.ts）要的三列，都是加列、有默认值或可空，旧代码照样能跑：
-- 池的会话用户；阶段里每条路由的开关（关着的挂着不派）；装载器接手某个阶段顺序的时刻（有值就不再动它）。
ALTER TABLE "pools" ADD COLUMN "session_user" text;--> statement-breakpoint
ALTER TABLE "stage_policies" ADD COLUMN "catalog_applied_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "stage_policy_routes" ADD COLUMN "enabled" boolean DEFAULT true NOT NULL;
