-- 删八张没人读写的表（创始人 2026-10-05 约 16:20 拍：「都按照你推荐」，推荐是删；全仓审查第 4 路 P15）：
-- 旧飞书网关的四张（feishu_drafts、feishu_follows、feishu_outbox、feishu_cards，#990 PR-5）、旧的按阶段平铺路由顺序两张
-- （stage_policies、stage_policy_routes，#754；触发器 0033 已摘）、叫停请求 session_stops、Fusion 的验证轮 verify_rounds。
-- 非测试代码里对它们 0 处读写；它们没有触发器，也没有别的表引用它们。session_runs 还有读方（选路、账单、对账、看板），不在这里。
-- 只放删表语句，不动别的；库里的旧行随表一起没了。
DROP TABLE "stage_policy_routes" CASCADE;--> statement-breakpoint
DROP TABLE "stage_policies" CASCADE;--> statement-breakpoint
DROP TABLE "feishu_cards" CASCADE;--> statement-breakpoint
DROP TABLE "feishu_drafts" CASCADE;--> statement-breakpoint
DROP TABLE "feishu_follows" CASCADE;--> statement-breakpoint
DROP TABLE "feishu_outbox" CASCADE;--> statement-breakpoint
DROP TABLE "session_stops" CASCADE;--> statement-breakpoint
DROP TABLE "verify_rounds" CASCADE;
