-- 「要你拍」带选项（#1915）：通知加选项和答案两列，老通知都是空（照旧显示，页面写「没有选项，请直接回复」）。
-- 'decision' 从 0000 起就在枚举里，这里拿它比不碰「同事务新加的枚举值」那个坑（见 0056 的注释）。
ALTER TABLE "notifications" ADD COLUMN "decision_options" jsonb;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "answer" jsonb;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_options_only_decision" CHECK ("notifications"."decision_options" is null or "notifications"."level" = 'decision');
