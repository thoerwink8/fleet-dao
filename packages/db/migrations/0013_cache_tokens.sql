ALTER TABLE "session_runs" ADD COLUMN "cache_read_tokens" bigint;--> statement-breakpoint
ALTER TABLE "session_runs" ADD COLUMN "cache_write_tokens" bigint;--> statement-breakpoint
ALTER TABLE "session_runs" ADD CONSTRAINT "session_runs_cache_nonneg" CHECK (coalesce("session_runs"."cache_read_tokens", 0) >= 0 and coalesce("session_runs"."cache_write_tokens", 0) >= 0);