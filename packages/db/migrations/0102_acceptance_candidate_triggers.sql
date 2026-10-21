-- 与0101在同一个pending迁移事务批内安装；旧写先结束，新写在触发器就位后继续。
LOCK TABLE acceptance_duties IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
CREATE FUNCTION invalidate_acceptance_candidate_group() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  keys_query text;
  affected record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    keys_query := 'SELECT DISTINCT task_id, pr_number FROM new_rows ORDER BY task_id, pr_number';
  ELSIF TG_OP = 'DELETE' THEN
    keys_query := 'SELECT DISTINCT task_id, pr_number FROM old_rows ORDER BY task_id, pr_number';
  ELSE
    keys_query := 'SELECT task_id, pr_number FROM old_rows UNION SELECT task_id, pr_number FROM new_rows ORDER BY task_id, pr_number';
  END IF;
  -- 整条语句的所有旧/新组统一键序，避免多行跨组更新仅逐行排序时反向取组锁。
  -- SQL只从上述三个常量选，不拼接用户内容。刷新者不持组锁等 duty。
  FOR affected IN EXECUTE keys_query
  LOOP
    INSERT INTO acceptance_candidate_groups(task_id, pr_number)
    SELECT affected.task_id, affected.pr_number FROM tasks WHERE id = affected.task_id
    ON CONFLICT (task_id, pr_number) DO UPDATE
      SET revision = acceptance_candidate_groups.revision + 1, dirty = true;
  END LOOP;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER acceptance_candidate_insert
AFTER INSERT ON acceptance_duties REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION invalidate_acceptance_candidate_group();
--> statement-breakpoint
CREATE TRIGGER acceptance_candidate_update
AFTER UPDATE ON acceptance_duties REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION invalidate_acceptance_candidate_group();
--> statement-breakpoint
CREATE TRIGGER acceptance_candidate_delete
AFTER DELETE ON acceptance_duties REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION invalidate_acceptance_candidate_group();
