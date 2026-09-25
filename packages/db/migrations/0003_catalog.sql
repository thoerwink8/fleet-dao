-- 目录装载器（src/catalog.ts）要的三列：池的会话跑在哪个系统用户下（不叫 session_user：那是 Postgres 保留字）；
-- 阶段里每条路由的开关（关着的挂着不派）；装载器接手某个阶段顺序的时刻（有值就不再动它）。
-- enabled 先带默认值把已有的行回填成开着，再去掉默认值：之后重写顺序的地方必须逐条带上开关，漏带就插不进去。
ALTER TABLE "pools" ADD COLUMN "run_as_user" text;--> statement-breakpoint
ALTER TABLE "stage_policies" ADD COLUMN "catalog_applied_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "stage_policy_routes" ADD COLUMN "enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "stage_policy_routes" ALTER COLUMN "enabled" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "pools" ADD CONSTRAINT "pools_run_as_user_known" CHECK ("pools"."run_as_user" is null or "pools"."run_as_user" in ('fleet-agent-dedicated', 'fleet-agent-carpool'));
