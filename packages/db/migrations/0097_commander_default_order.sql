-- 法国指挥官会话（母单 #3294 第 2 片）的默认顺序 grok-4.7 → sonnet-5.5 → opus-5.5。
-- 新枚举值要等上一条迁移提交后才能用，所以单列一条。全新空库由发布时按 routing.default.json 整份写；
-- 这里只补「已经配过路由、还没有指挥官这一用途」的库，且只补库里有的模型；驾驶舱以后改了不再动。
INSERT INTO "routing_purpose_models" ("purpose", "model_id", "position")
SELECT 'commander', m.id, ord.position
FROM (VALUES ('grok-4.7', 0), ('sonnet-5.5', 1), ('opus-5.5', 2)) AS ord(model_id, position)
JOIN "models" m ON m.id = ord.model_id
WHERE EXISTS (SELECT 1 FROM "routing_purpose_models" WHERE "purpose" = 'groom')
  AND NOT EXISTS (SELECT 1 FROM "routing_purpose_models" WHERE "purpose" = 'commander');
