CREATE TABLE "acceptance_candidate_bootstrap" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"semantics_version" integer NOT NULL,
	"cursor_id" bigint DEFAULT 0 NOT NULL,
	"high_water_id" bigint NOT NULL,
	"ready" boolean DEFAULT false NOT NULL,
	CONSTRAINT "acceptance_candidate_bootstrap_singleton" CHECK ("acceptance_candidate_bootstrap"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "acceptance_candidate_groups" (
	"task_id" uuid NOT NULL,
	"pr_number" integer NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"dirty" boolean DEFAULT true NOT NULL,
	"has_open" boolean DEFAULT false NOT NULL,
	"last_attempt_at" timestamp with time zone,
	CONSTRAINT "acceptance_candidate_groups_task_id_pr_number_pk" PRIMARY KEY("task_id","pr_number")
);
--> statement-breakpoint
ALTER TABLE "acceptance_candidate_groups" ADD CONSTRAINT "acceptance_candidate_groups_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "acceptance_candidate_dirty_idx" ON "acceptance_candidate_groups" USING btree ("last_attempt_at" NULLS FIRST,"task_id","pr_number") WHERE "acceptance_candidate_groups"."dirty";--> statement-breakpoint
CREATE INDEX "acceptance_candidate_open_idx" ON "acceptance_candidate_groups" USING btree ("task_id","pr_number") WHERE "acceptance_candidate_groups"."has_open";--> statement-breakpoint
CREATE INDEX "runs_task_workflow_latest_idx" ON "runs" USING btree ("task_id","started_at" DESC NULLS LAST,"created_at" DESC NULLS LAST) WHERE "runs"."workflow_id" is not null;
--> statement-breakpoint
-- 同一迁移事务内安装；旧写先结束，新写在触发器就位后继续。
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
