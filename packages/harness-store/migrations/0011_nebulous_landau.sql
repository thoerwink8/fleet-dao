ALTER TABLE "fleet2"."ade_sessions" ADD COLUMN "pinned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "fleet2"."ade_sessions" ADD COLUMN "archived" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "fleet2"."ade_sessions" ADD COLUMN "turns" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "fleet2"."ade_sessions" ADD COLUMN "context" jsonb;--> statement-breakpoint
-- 已有会话的轮数按当时记下的开跑事件回填，不按事件总条数估。
UPDATE "fleet2"."ade_sessions" AS s SET "turns" = (
  SELECT count(*)::int FROM "fleet2"."events" AS e
  WHERE e.stream_id = 'session:' || s.id AND e.type = 'session.turn.started'
);