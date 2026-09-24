-- 手写迁移：drizzle-kit 生成不了函数和触发器。整份单独重跑也不报错（函数 CREATE OR REPLACE，触发器先 DROP IF EXISTS）。
-- 触发器一律不写列名（不用 UPDATE OF 列 / WHEN 引用列）：那样会把列绑在触发器上，以后 drizzle-kit 改列类型（比如删枚举值）会报
-- cannot alter type of a column used in a trigger definition。要比较的新旧值放进函数里比。
--
-- ① 实时：@fleet-dao/shared 的 REALTIME_TABLES 里的表一有写入就 NOTIFY fleet_changes（测试逐表核对这份名单）。
--    载荷只有表名和 id（一律是文本），例如 {"table":"tasks","id":"…"}，驾驶舱后端收到后按 id 回库里读。
--    参数一：id 取哪一列；参数二（可选）：载荷里报哪张表，默认就是触发的表。
--    quota_windows 报 pool_id（额度按池刷新）；stage_policy_routes 报成 stage_policies、id 是阶段名（改路由顺序也要刷新）。
--    写错列名当场报错，不会发出 id 为空的通知。UPDATE 改了 id 列时新旧两个 id 都发。
CREATE OR REPLACE FUNCTION fleet_notify_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  id_column text := TG_ARGV[0];
  reported_table text := coalesce(TG_ARGV[1], TG_TABLE_NAME);
  recs jsonb[] := ARRAY[]::jsonb[];
  rec jsonb;
BEGIN
  IF TG_NARGS NOT IN (1, 2) THEN
    RAISE EXCEPTION 'fleet_notify_change on %: arguments are (id column [, reported table])', TG_TABLE_NAME;
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    recs := array_append(recs, to_jsonb(OLD));
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    recs := array_append(recs, to_jsonb(NEW));
  END IF;
  FOREACH rec IN ARRAY recs LOOP
    IF (rec ->> id_column) IS NULL THEN
      RAISE EXCEPTION 'fleet_notify_change on %: column % missing or null', TG_TABLE_NAME, id_column;
    END IF;
    -- 同一事务里载荷相同的通知 Postgres 只发一次，所以没改 id 的 UPDATE 只到一条。
    PERFORM pg_notify('fleet_changes', jsonb_build_object('table', reported_table, 'id', rec ->> id_column)::text);
  END LOOP;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS tasks_notify ON tasks;
--> statement-breakpoint
CREATE TRIGGER tasks_notify AFTER INSERT OR UPDATE OR DELETE ON tasks
  FOR EACH ROW EXECUTE FUNCTION fleet_notify_change('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS subtasks_notify ON subtasks;
--> statement-breakpoint
CREATE TRIGGER subtasks_notify AFTER INSERT OR UPDATE OR DELETE ON subtasks
  FOR EACH ROW EXECUTE FUNCTION fleet_notify_change('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS session_runs_notify ON session_runs;
--> statement-breakpoint
CREATE TRIGGER session_runs_notify AFTER INSERT OR UPDATE OR DELETE ON session_runs
  FOR EACH ROW EXECUTE FUNCTION fleet_notify_change('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS progress_events_notify ON progress_events;
--> statement-breakpoint
CREATE TRIGGER progress_events_notify AFTER INSERT OR UPDATE OR DELETE ON progress_events
  FOR EACH ROW EXECUTE FUNCTION fleet_notify_change('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS quota_windows_notify ON quota_windows;
--> statement-breakpoint
CREATE TRIGGER quota_windows_notify AFTER INSERT OR UPDATE OR DELETE ON quota_windows
  FOR EACH ROW EXECUTE FUNCTION fleet_notify_change('pool_id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS notifications_notify ON notifications;
--> statement-breakpoint
CREATE TRIGGER notifications_notify AFTER INSERT OR UPDATE OR DELETE ON notifications
  FOR EACH ROW EXECUTE FUNCTION fleet_notify_change('id');
--> statement-breakpoint
-- asks 有变化（尤其是答上了）就叫醒正在等这一问的 fleet ask。
DROP TRIGGER IF EXISTS asks_notify ON asks;
--> statement-breakpoint
CREATE TRIGGER asks_notify AFTER INSERT OR UPDATE OR DELETE ON asks
  FOR EACH ROW EXECUTE FUNCTION fleet_notify_change('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS stage_policies_notify ON stage_policies;
--> statement-breakpoint
CREATE TRIGGER stage_policies_notify AFTER INSERT OR UPDATE OR DELETE ON stage_policies
  FOR EACH ROW EXECUTE FUNCTION fleet_notify_change('stage');
--> statement-breakpoint
DROP TRIGGER IF EXISTS stage_policy_routes_notify ON stage_policy_routes;
--> statement-breakpoint
CREATE TRIGGER stage_policy_routes_notify AFTER INSERT OR UPDATE OR DELETE ON stage_policy_routes
  FOR EACH ROW EXECUTE FUNCTION fleet_notify_change('stage', 'stage_policies');
--> statement-breakpoint
DROP TRIGGER IF EXISTS channels_notify ON channels;
--> statement-breakpoint
CREATE TRIGGER channels_notify AFTER INSERT OR UPDATE OR DELETE ON channels
  FOR EACH ROW EXECUTE FUNCTION fleet_notify_change('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS settings_notify ON settings;
--> statement-breakpoint
CREATE TRIGGER settings_notify AFTER INSERT OR UPDATE OR DELETE ON settings
  FOR EACH ROW EXECUTE FUNCTION fleet_notify_change('key');
--> statement-breakpoint
DROP TRIGGER IF EXISTS audit_log_notify ON audit_log;
--> statement-breakpoint
CREATE TRIGGER audit_log_notify AFTER INSERT OR UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION fleet_notify_change('id');
--> statement-breakpoint
-- ② 状态变化：需求和子任务一建或一改状态，就往 state_changes 记一行（参数：task / subtask）。
--    由库记，应用不用写、也写不漏；状态没变的 UPDATE 不记（在函数里比，不在触发器上绑 state 列）。
CREATE OR REPLACE FUNCTION fleet_record_state_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  row_new jsonb := to_jsonb(NEW);
  old_state text := to_jsonb(OLD) ->> 'state';
BEGIN
  IF TG_OP = 'UPDATE' AND old_state IS NOT DISTINCT FROM (row_new ->> 'state') THEN
    RETURN NULL;
  END IF;
  INSERT INTO state_changes (entity, entity_id, task_id, from_state, to_state, at)
  VALUES (
    TG_ARGV[0]::state_entity,
    (row_new ->> 'id')::uuid,
    coalesce((row_new ->> 'task_id')::uuid, (row_new ->> 'id')::uuid),
    old_state,
    row_new ->> 'state',
    clock_timestamp()
  );
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS tasks_state_change ON tasks;
--> statement-breakpoint
CREATE TRIGGER tasks_state_change AFTER INSERT OR UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION fleet_record_state_change('task');
--> statement-breakpoint
DROP TRIGGER IF EXISTS subtasks_state_change ON subtasks;
--> statement-breakpoint
CREATE TRIGGER subtasks_state_change AFTER INSERT OR UPDATE ON subtasks
  FOR EACH ROW EXECUTE FUNCTION fleet_record_state_change('subtask');
