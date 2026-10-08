CREATE TABLE "routing_purpose_revisions" (
	"purpose" "stage_kind" PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	CONSTRAINT "routing_purpose_revisions_version_nonneg" CHECK ("routing_purpose_revisions"."version" >= 0)
);
--> statement-breakpoint
ALTER TABLE "routing_purpose_models" ADD COLUMN "effort" text;--> statement-breakpoint
ALTER TABLE "routing_purpose_models" ADD CONSTRAINT "routing_purpose_models_effort_known" CHECK ("routing_purpose_models"."effort" is null or "routing_purpose_models"."effort" in ('low', 'medium', 'high', 'xhigh', 'max'));