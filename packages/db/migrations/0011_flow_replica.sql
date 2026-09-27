ALTER TABLE "repos" ADD COLUMN "flow_config" jsonb;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "flow_source" text;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "flow_commit" text;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "flow_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "flow_error" text;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "flow_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "flow_unread" text;--> statement-breakpoint
ALTER TABLE "session_runs" ADD COLUMN "test_command" text;--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_flow_source_known" CHECK ("repos"."flow_source" is null or "repos"."flow_source" in ('project', 'org_default'));--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_flow_synced_together" CHECK (("repos"."flow_synced_at" is null) = ("repos"."flow_config" is null) and ("repos"."flow_synced_at" is null) = ("repos"."flow_source" is null) and ("repos"."flow_synced_at" is null) = ("repos"."flow_commit" is null));--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_flow_reasons_not_blank" CHECK (("repos"."flow_error" is null or "repos"."flow_error" <> '') and ("repos"."flow_unread" is null or "repos"."flow_unread" <> ''));--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_flow_config_shape" CHECK ("repos"."flow_config" is null or (jsonb_typeof("repos"."flow_config") = 'object' and (jsonb_typeof("repos"."flow_config" -> 'testCommand') is null or (jsonb_typeof("repos"."flow_config" -> 'testCommand') = 'string' and "repos"."flow_config" ->> 'testCommand' <> ''))));--> statement-breakpoint
ALTER TABLE "session_runs" ADD CONSTRAINT "session_runs_test_command_not_blank" CHECK ("session_runs"."test_command" is null or "session_runs"."test_command" <> '');