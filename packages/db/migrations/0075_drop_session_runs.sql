-- 删老流程（Fusion）的会话表 session_runs 和只靠它的进度表 progress_events（#2357）。
-- session_runs 法国库里最后一行写入是 2026-09-29（共 215 行，没有未收场的）；progress_events 14077 行全是那 215 个会话的，
-- 没有任何代码再写它、读它。读 session_runs 的查询（拼车花费、池里在跑的会话、对账、工作树归属、额度读数）已改读 runs。
-- 旧行随表一起没了（备份有每晚一份，见 ops 第十一节）；和 0037 删八张没人读写的表是同一个做法。
-- 外键：progress_events 随表删；asks 对 session_runs 的 (task_id, run_id) 复合外键改指 runs（先在 runs 上补
-- (task_id, id) 的唯一约束），asks 里指着旧会话的 run_id（法国 6 行，runs 里没有这些编号）先置空，问的话、选项、回答都留着。
-- worktree_path 是 runs 新加的一列：每小时对账删树前认「树里有没有没结束的会话」、工作树清单的「最近一次会话」以前读 session_runs 的这一列。
UPDATE "asks" SET "run_id" = NULL
WHERE "run_id" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "runs" r WHERE r."id" = "asks"."run_id" AND r."task_id" = "asks"."task_id");--> statement-breakpoint
ALTER TABLE "asks" DROP CONSTRAINT "asks_run_in_task_fk";--> statement-breakpoint
ALTER TABLE "progress_events" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "session_runs" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "progress_events" CASCADE;--> statement-breakpoint
DROP TABLE "session_runs" CASCADE;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "worktree_path" text;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_task_id_id_unique" UNIQUE("task_id","id");--> statement-breakpoint
ALTER TABLE "asks" ADD CONSTRAINT "asks_run_in_task_fk" FOREIGN KEY ("task_id","run_id") REFERENCES "public"."runs"("task_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
DROP TYPE "public"."progress_kind";--> statement-breakpoint
DROP TYPE "public"."run_outcome";
