-- 删掉从没开过、没跑过、没被钉过、也没被别的表引用的路由。
-- 目录发现曾经给每个看见的上游串自动插一行（默认关着）。在线的、用途里开着的、跑过或被钉过的都留着。
-- 关着的 routing_catalog 行只是挂在模型下，不算「在用」，和路由一起删；开着的（enabled）一条不删。
-- 不改 routing_purpose_models，不重排剩下的 position，不删模型。重跑匹配不到行，不再记操作记录。

-- 先摘掉挡住删除的目录行（外键）。只摘「这条路由本身就该删」的那些，开着的不动。
DELETE FROM "routing_catalog" AS c
USING "routes" AS r
WHERE c."route_id" = r."id"
  AND r."alive" = false
  AND NOT EXISTS (
    SELECT 1 FROM "routing_catalog" AS e WHERE e."route_id" = r."id" AND e."enabled"
  )
  AND NOT EXISTS (SELECT 1 FROM "runs" AS x WHERE x."route_id" = r."id")
  AND NOT EXISTS (SELECT 1 FROM "session_runs" AS x WHERE x."route_id" = r."id")
  AND NOT EXISTS (SELECT 1 FROM "route_probe_history" AS x WHERE x."route_id" = r."id")
  AND NOT EXISTS (SELECT 1 FROM "task_route_pins" AS x WHERE x."route_id" = r."id")
  AND NOT EXISTS (SELECT 1 FROM "channel_attempts" AS x WHERE x."route_id" = r."id")
  AND NOT EXISTS (SELECT 1 FROM "channel_states" AS x WHERE x."failed_route_id" = r."id")
  AND NOT EXISTS (SELECT 1 FROM "pool_reservations" AS x WHERE x."route_id" = r."id")
  AND NOT EXISTS (SELECT 1 FROM "request_chats" AS x WHERE x."route_id" = r."id");
--> statement-breakpoint
WITH dropped AS (
  DELETE FROM "routes" AS r
  WHERE r."alive" = false
    AND NOT EXISTS (
      SELECT 1 FROM "routing_catalog" AS e WHERE e."route_id" = r."id" AND e."enabled"
    )
    AND NOT EXISTS (SELECT 1 FROM "runs" AS x WHERE x."route_id" = r."id")
    AND NOT EXISTS (SELECT 1 FROM "session_runs" AS x WHERE x."route_id" = r."id")
    AND NOT EXISTS (SELECT 1 FROM "route_probe_history" AS x WHERE x."route_id" = r."id")
    AND NOT EXISTS (SELECT 1 FROM "task_route_pins" AS x WHERE x."route_id" = r."id")
    AND NOT EXISTS (SELECT 1 FROM "channel_attempts" AS x WHERE x."route_id" = r."id")
    AND NOT EXISTS (SELECT 1 FROM "channel_states" AS x WHERE x."failed_route_id" = r."id")
    AND NOT EXISTS (SELECT 1 FROM "pool_reservations" AS x WHERE x."route_id" = r."id")
    AND NOT EXISTS (SELECT 1 FROM "request_chats" AS x WHERE x."route_id" = r."id")
  RETURNING r."id"
),
n AS (SELECT count(*)::int AS deleted FROM dropped)
INSERT INTO "audit_log" ("actor_kind", "actor_id", "action", "target", "reason", "via", "after")
SELECT
  'engine',
  'migration:0074',
  'catalog.prune-routes',
  'routes',
  '删掉从没开过、没跑过、没被引用的路由',
  'engine',
  jsonb_build_object('deleted', n.deleted)
FROM n
WHERE n.deleted > 0;
