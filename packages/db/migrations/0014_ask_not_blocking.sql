ALTER TABLE "asks" ADD COLUMN "recommended" text;--> statement-breakpoint
ALTER TABLE "asks" ADD COLUMN "scope" text;--> statement-breakpoint
ALTER TABLE "asks" ADD COLUMN "hold" text;--> statement-breakpoint
ALTER TABLE "asks" ADD COLUMN "follow_up_issue" integer;--> statement-breakpoint
ALTER TABLE "asks" ADD COLUMN "applied_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "asks" ADD CONSTRAINT "asks_scope_known" CHECK ("asks"."scope" is null or "asks"."scope" in ('task', 'outside', 'hold'));--> statement-breakpoint
ALTER TABLE "asks" ADD CONSTRAINT "asks_scoped_recommendation" CHECK ("asks"."scope" is null or ("asks"."recommended" is not null and "asks"."recommended" = any("asks"."options")));--> statement-breakpoint
ALTER TABLE "asks" ADD CONSTRAINT "asks_hold_shape" CHECK (("asks"."scope" is not distinct from 'hold') = ("asks"."hold" is not null));--> statement-breakpoint
ALTER TABLE "asks" ADD CONSTRAINT "asks_hold_known" CHECK ("asks"."hold" is null or "asks"."hold" in ('release', 'spend', 'delete', 'standard'));--> statement-breakpoint
ALTER TABLE "asks" ADD CONSTRAINT "asks_applied_answered" CHECK ("asks"."applied_at" is null or "asks"."answer" is not null);--> statement-breakpoint
ALTER TABLE "asks" ADD CONSTRAINT "asks_follow_up_positive" CHECK ("asks"."follow_up_issue" is null or "asks"."follow_up_issue" > 0);