-- 已删功能留下的、还开着的提醒：canary:（全流程巡检，决定 0093）、no-verifier:（开 PR 前验证留一家）、
-- retired-schedule:（当时还开着的）。一次性标成已撤，原因「功能已删」。只改状态（处理时刻、处理人、更新时刻、正文开头的原因），不删行。
-- 已经撤过的不动。重跑匹配不到开着的行，不会把原因再写一遍，也不会再记一笔操作记录。
WITH closed AS (
  UPDATE "notifications"
  SET
    "resolved_at" = now(),
    "resolved_by" = 'migration:0072',
    "updated_at" = now(),
    "body" = '已撤：功能已删' || CASE WHEN "body" = '' THEN '' ELSE E'\n\n' || "body" END
  WHERE "resolved_at" IS NULL
    AND (
      starts_with("dedupe_key", 'canary:')
      OR starts_with("dedupe_key", 'no-verifier:')
      OR starts_with("dedupe_key", 'retired-schedule:')
    )
  RETURNING "id"
)
INSERT INTO "audit_log" ("actor_kind", "actor_id", "action", "target", "reason", "via")
SELECT 'engine', 'migration:0072', 'notification.resolve', 'notification:' || "id", '功能已删', 'engine'
FROM closed;
