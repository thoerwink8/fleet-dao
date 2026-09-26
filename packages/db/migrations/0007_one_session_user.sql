ALTER TABLE "pools" DROP CONSTRAINT "pools_run_as_user_known";--> statement-breakpoint
ALTER TABLE "pools" ADD COLUMN "org_kind" text;--> statement-breakpoint
ALTER TABLE "pools" ADD CONSTRAINT "pools_org_kind_known" CHECK ("pools"."org_kind" is null or "pools"."org_kind" in ('solo', 'carpool'));--> statement-breakpoint
UPDATE "pools" SET "org_kind" = CASE "run_as_user" WHEN 'fleet-agent-dedicated' THEN 'solo' WHEN 'fleet-agent-carpool' THEN 'carpool' END WHERE "org_kind" IS NULL AND "run_as_user" IS NOT NULL;--> statement-breakpoint
UPDATE "pools" SET "run_as_user" = 'fleet-agent-carpool' WHERE "run_as_user" = 'fleet-agent-dedicated';--> statement-breakpoint
ALTER TABLE "pools" ADD CONSTRAINT "pools_run_as_user_known" CHECK ("pools"."run_as_user" is null or "pools"."run_as_user" in ('fleet-agent-carpool'));
