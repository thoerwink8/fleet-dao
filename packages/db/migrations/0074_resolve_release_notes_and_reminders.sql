-- 开着的发版开始、发版成功（release:start:、release:done:）和再提醒（remind:）不再进通知表：
-- 一次性标成已撤，原因「发版开始、成功和再提醒不再进通知表」。只改状态（处理时刻、处理人、更新时刻、正文开头的原因），不删行。
-- 卡住、失败、体检没过（release:check:、release:blocked:、release:failed:）仍要人看，不在这里收。
-- 已经撤过的不动。重跑匹配不到开着的行，不会把原因再写一遍，也不会再记一笔操作记录。
WITH closed AS (
  UPDATE "notifications"
  SET
    "resolved_at" = now(),
    "resolved_by" = 'migration:0074',
    "updated_at" = now(),
    "body" = '已撤：发版开始、成功和再提醒不再进通知表' || CASE WHEN "body" = '' THEN '' ELSE E'\n\n' || "body" END
  WHERE "resolved_at" IS NULL
    AND (
      starts_with("dedupe_key", 'release:start:')
      OR starts_with("dedupe_key", 'release:done:')
      OR starts_with("dedupe_key", 'remind:')
    )
  RETURNING "id"
)
INSERT INTO "audit_log" ("actor_kind", "actor_id", "action", "target", "reason", "via")
SELECT 'engine', 'migration:0074', 'notification.resolve', 'notification:' || "id", '发版开始、成功和再提醒不再进通知表', 'engine'
FROM closed;
