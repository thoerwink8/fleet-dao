-- 旧的按阶段平铺路由表（stage_policies / stage_policy_routes）没人再写、再读了（#754）：写入的通知触发器和两张表的
-- 建表语句一起留着，正在监听 stage_policies 的页面会悄悄收不到变化——名单在 shared 的 REALTIME_TABLES，触发器逐个
-- 核那份名单（db 的 notify.test.ts）。
-- 这里只摘触发器，不删表也不删数据：旧的阶段顺序原样留在库里，删表是另一个只放迁移的 PR、要创始人点头（#754）。
DROP TRIGGER IF EXISTS stage_policies_notify ON stage_policies;
--> statement-breakpoint
DROP TRIGGER IF EXISTS stage_policy_routes_notify ON stage_policy_routes;
