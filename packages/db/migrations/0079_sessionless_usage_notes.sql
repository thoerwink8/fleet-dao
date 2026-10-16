-- 没有会话号的老 run（#2689）：补记任务不收，用量一直空着，看板上分不清真漏和没跑起来。
-- 判法和 db 的 annotateSessionlessRuns、shared 的 sessionlessUsage 同一套。
-- 确定没发出模型调用的（总开关关、内存不够、起会话失败、起会话之前就停了）记 0，并写原因。
-- 其余记「会话号没拿到，用量读不到」，数留空（可能已经调用过模型，不能记成 0）。
-- 只动近 14 天已经结束、原因还空着的。已经有原因的、有会话号的、还在跑的、更早的不动。
-- 重跑匹配不到，不会改第二次。

UPDATE runs
SET
  input_tokens = 0,
  output_tokens = 0,
  cache_read_tokens = 0,
  cache_write_tokens = 0,
  cost_usd = coalesce(cost_usd, 0),
  usage_note = CASE
    WHEN outcome = 'admission_blocked' THEN '内存不够，没起会话，没有模型调用'
    WHEN outcome = 'spawn_failed' THEN '起会话失败，没有模型调用'
    WHEN failure_reason LIKE '%总开关%' THEN '总开关关，没起会话，没有模型调用'
    ELSE '还没起会话，没有模型调用'
  END,
  updated_at = now()
WHERE
  session_id IS NULL
  AND usage_note IS NULL
  AND ended_at IS NOT NULL
  AND ended_at >= now() - interval '14 days'
  AND input_tokens IS NULL
  AND output_tokens IS NULL
  AND cache_read_tokens IS NULL
  AND cache_write_tokens IS NULL
  AND (
    outcome = 'admission_blocked'
    OR outcome = 'spawn_failed'
    OR (
      outcome = 'org_switch'
      AND (
        failure_reason LIKE '%还没起会话%'
        OR failure_reason LIKE '%这一段没起会话%'
      )
    )
  );--> statement-breakpoint
UPDATE runs
SET
  usage_note = '会话号没拿到，用量读不到',
  updated_at = now()
WHERE
  session_id IS NULL
  AND usage_note IS NULL
  AND ended_at IS NOT NULL
  AND ended_at >= now() - interval '14 days';
--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "strength" text;
--> statement-breakpoint
ALTER TABLE "models" ADD CONSTRAINT "models_strength_known" CHECK ("models"."strength" is null or "models"."strength" in ('strong', 'standard', 'light'));
