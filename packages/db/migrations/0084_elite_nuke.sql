CREATE TYPE "public"."decision_reason" AS ENUM('new-money', 'irreversible-delete', 'human-only');--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "decision_reason" "decision_reason";--> statement-breakpoint
-- #2729：加约束之前先把旧行理顺，免得在法国发版时迁移失败。没有两个以上选项的「要你拍」（法国 10-16 只读数过：15 条里 14 条，
-- 全已处理；发版脚本直写的 release:、worktree:、pool-hold:、unclaimed:、close-sweep:、github-app-missing:）降成卡住报警、去掉选项；
-- 带着选项的（github-app: 那种，机器人权限只有创始人在 GitHub 上能授）记成「只有人能做」。重跑结果一样。
UPDATE "notifications" SET "level" = 'alert', "decision_options" = NULL
WHERE "level" = 'decision'
  AND ("decision_options" IS NULL OR jsonb_typeof("decision_options") <> 'array' OR jsonb_array_length("decision_options") < 2);--> statement-breakpoint
UPDATE "notifications" SET "decision_reason" = 'human-only' WHERE "level" = 'decision' AND "decision_reason" IS NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_decision_needs_options_reason" CHECK ("notifications"."level" <> 'decision' or ("notifications"."decision_options" is not null and jsonb_typeof("notifications"."decision_options") = 'array' and jsonb_array_length("notifications"."decision_options") >= 2 and "notifications"."decision_reason" is not null));--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_reason_only_decision" CHECK ("notifications"."decision_reason" is null or "notifications"."level" = 'decision');
