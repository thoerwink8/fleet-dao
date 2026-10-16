-- 通知表只放要人动手的事（#2368）：发版开始、发版成功（release:start:、release:done:）和再提醒（remind:）不再写通知，
-- 还开着的老行一次性标成已撤，原因「不再写这类通知」。只改状态（处理时刻、处理人、更新时刻、正文开头的原因），不删行。
-- 已经撤过的不动。重跑匹配不到开着的行，不会把原因再写一遍，也不会再记一笔操作记录。
WITH closed AS (
  UPDATE "notifications"
  SET
    "resolved_at" = now(),
    "resolved_by" = 'migration:0078',
    "updated_at" = now(),
    "body" = '已撤：不再写这类通知' || CASE WHEN "body" = '' THEN '' ELSE E'\n\n' || "body" END
  WHERE "resolved_at" IS NULL
    AND (
      starts_with("dedupe_key", 'release:start:')
      OR starts_with("dedupe_key", 'release:done:')
      OR starts_with("dedupe_key", 'remind:')
    )
  RETURNING "id"
)
INSERT INTO "audit_log" ("actor_kind", "actor_id", "action", "target", "reason", "via")
SELECT 'engine', 'migration:0078', 'notification.resolve', 'notification:' || "id", '不再写这类通知', 'engine'
FROM closed;
