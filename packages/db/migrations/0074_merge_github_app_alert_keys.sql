-- 机器人没装、权限不对以前一个仓最多三个键：github-app:agent:<仓>、github-app:engine:<仓>、github-app-missing:<仓>，
-- 同一件事飞书同一分钟收到三条（#2369）。现在每个仓只留一个键 github-app:<仓>（正文写清是哪个机器人缺什么）。
-- 开着的老键一次性标成已撤，原因「已合并成每个仓一条」；仍然有问题的仓，下一轮每小时对账会用新键重新报。
-- 只改状态（处理时刻、处理人、更新时刻、正文开头的原因），不删行。已经撤过的不动；重跑匹配不到开着的行，不会再记操作记录。
WITH closed AS (
  UPDATE "notifications"
  SET
    "resolved_at" = now(),
    "resolved_by" = 'migration:0074',
    "updated_at" = now(),
    "body" = '已撤：已合并成每个仓一条（github-app:<仓>），仍有问题下一轮每小时对账会重新报' || CASE WHEN "body" = '' THEN '' ELSE E'\n\n' || "body" END
  WHERE "resolved_at" IS NULL
    AND (
      starts_with("dedupe_key", 'github-app-missing:')
      OR starts_with("dedupe_key", 'github-app:agent:')
      OR starts_with("dedupe_key", 'github-app:engine:')
    )
  RETURNING "id"
)
INSERT INTO "audit_log" ("actor_kind", "actor_id", "action", "target", "reason", "via")
SELECT 'engine', 'migration:0074', 'notification.resolve', 'notification:' || "id", '已合并成每个仓一条', 'engine'
FROM closed;
