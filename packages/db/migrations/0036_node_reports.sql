-- 看板多机（全仓审查第 1 路 4.1）：别的环境推来的快照，一个环境一行、覆盖写。只建表和 NOTIFY 触发器，不改不删已有的。
-- 进实时名单（shared 的 REALTIME_TABLES 加了 node_reports）：触发器写法照 0001_triggers.sql，函数 fleet_notify_change 就是那里建的；
-- 不写 DROP TRIGGER IF EXISTS（迁移只跑一次，同名已有就该报错，不悄悄替换）。
CREATE TABLE "node_reports" (
	"node_id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"schema_version" integer NOT NULL,
	"code_sha" text,
	"reported_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TRIGGER node_reports_notify AFTER INSERT OR UPDATE OR DELETE ON node_reports
  FOR EACH ROW EXECUTE FUNCTION fleet_notify_change('node_id');
