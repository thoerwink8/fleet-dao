-- 通知加「哪个项目（仓）」这一列（#2759）：首页按项目出卡要看得出每条提醒属于哪个仓。
-- 两条回填依据（和 src/schema/ops.ts 上那一列的说明一字对上）：
-- 1. 挂了单的，取那张单的仓（tasks.repo_id）；
-- 2. 去重键里带 owner/name 的，按那个仓认——github-app:<owner/name>、close-sweep:<owner/name>:<种类>。
-- 都对不上就留空（整机的事，不藏）。写成一条 UPDATE：先按单回填，再按键补上还空着的（挂单的那张单没了、键里才有仓的）。
-- 键里认不出的（quota-read:<池>、worktree:<路径>、watchdog:merge:<仓>:…）不猜：那些键的「仓」没有稳定的写法，猜错就把提醒归错项目。
-- 重跑结果一样（只填空着的）。
ALTER TABLE "notifications" ADD COLUMN "repo_id" uuid;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_repo_idx" ON "notifications" USING btree ("repo_id");--> statement-breakpoint
UPDATE "notifications" n
SET "repo_id" = t."repo_id"
FROM "tasks" t
WHERE n."task_id" = t."id" AND n."repo_id" IS NULL;--> statement-breakpoint
UPDATE "notifications" n
SET "repo_id" = r."id"
FROM "repos" r
WHERE n."repo_id" IS NULL
  AND (
    n."dedupe_key" = 'github-app:' || r."owner" || '/' || r."name"
    OR n."dedupe_key" LIKE 'close-sweep:' || r."owner" || '/' || r."name" || ':%'
  );
