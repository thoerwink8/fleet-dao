-- 三段流水 runs（0023）进实时名单：shared 的 REALTIME_TABLES 加了 runs，这里给它装 NOTIFY 触发器（写法照 0001_triggers.sql，
-- 函数 fleet_notify_change 就是那里建的）。主页的流水线图和任务详情的流水读它，没有这条，单子换了段主页要刷新才看得到。
-- 只加触发器，不改表、不动数据；也不写 DROP TRIGGER IF EXISTS（迁移只跑一次，同名已有就该报错，不悄悄替换）。
CREATE TRIGGER runs_notify AFTER INSERT OR UPDATE OR DELETE ON runs
  FOR EACH ROW EXECUTE FUNCTION fleet_notify_change('id');
