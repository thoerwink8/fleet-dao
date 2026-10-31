-- 投影能从事件重建：先清空 stream_heads 和它的检查点，新列才能直接 NOT NULL，之后读的时候顺手补齐
DELETE FROM "fleet2"."stream_heads";--> statement-breakpoint
DELETE FROM "fleet2"."projection_checkpoints" WHERE "name" = 'stream_heads';--> statement-breakpoint
ALTER TABLE "fleet2"."stream_heads" ADD COLUMN "last_event_id" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "fleet2"."stream_heads" ADD COLUMN "last_at" timestamp with time zone NOT NULL;--> statement-breakpoint
CREATE INDEX "events_stream_id_idx" ON "fleet2"."events" USING btree ("stream_id","id");--> statement-breakpoint
CREATE INDEX "stream_heads_session_last_idx" ON "fleet2"."stream_heads" USING btree ("last_event_id" DESC NULLS LAST) WHERE "fleet2"."stream_heads"."stream_id" like 'session:%';