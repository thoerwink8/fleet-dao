-- 所有权令牌（决定 0124，#3773）：owner、executor、claimed_by 任一变了 fencing 就加一。
-- 放在触发器里：旧代码改执行方、本机领单、退回法国的各条写路径都不用记得自己加。
CREATE FUNCTION tasks_bump_fencing() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner IS DISTINCT FROM OLD.owner
     OR NEW.executor IS DISTINCT FROM OLD.executor
     OR NEW.claimed_by IS DISTINCT FROM OLD.claimed_by THEN
    NEW.fencing := OLD.fencing + 1;
  ELSE
    -- 写方不能自己改令牌：别的列变了、令牌原样
    NEW.fencing := OLD.fencing;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER tasks_bump_fencing BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION tasks_bump_fencing();
