-- 仓档案回填（#2738）：fleet-dao 那一行写上模块根和合并要等的检查（引擎原来照它写死的两样）。
-- 已经写过的键不覆盖（档案在前的键优先），别的仓不动；重跑结果一样。
UPDATE "repos"
SET "profile" = '{"moduleRoots": ["packages/*"], "mergeSignals": ["merge-gate", "cold-verify"]}'::jsonb || "profile"
WHERE lower("owner") = 'thoerwink8' AND lower("name") = 'fleet-dao';
