CREATE TABLE "acceptance_duty_supersessions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "acceptance_duty_supersessions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"source_id" bigint NOT NULL,
	"source_generation" integer NOT NULL,
	"source_head" text NOT NULL,
	"target_id" bigint NOT NULL,
	"target_generation" integer NOT NULL,
	"target_head" text NOT NULL,
	"target_merge_commit" text NOT NULL,
	"repo" text NOT NULL,
	"issue_number" integer NOT NULL,
	"pr_number" integer NOT NULL,
	"by" text NOT NULL,
	"evidence" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "acceptance_duty_supersessions_distinct" CHECK ("acceptance_duty_supersessions"."source_id" <> "acceptance_duty_supersessions"."target_id"),
	CONSTRAINT "acceptance_duty_supersessions_signed" CHECK (length("acceptance_duty_supersessions"."by") > 0 and length("acceptance_duty_supersessions"."evidence") > 0)
);
--> statement-breakpoint
ALTER TABLE "acceptance_duties" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "acceptance_duties" ADD COLUMN "superseded_by" text;--> statement-breakpoint
ALTER TABLE "acceptance_duties" ADD COLUMN "supersede_evidence" text;--> statement-breakpoint
ALTER TABLE "acceptance_duties" ADD COLUMN "successor_id" bigint;--> statement-breakpoint
ALTER TABLE "acceptance_duties" ADD COLUMN "successor_generation" integer;--> statement-breakpoint
ALTER TABLE "acceptance_duty_supersessions" ADD CONSTRAINT "acceptance_duty_supersessions_source_id_acceptance_duties_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."acceptance_duties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acceptance_duty_supersessions" ADD CONSTRAINT "acceptance_duty_supersessions_target_id_acceptance_duties_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."acceptance_duties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "acceptance_duty_supersessions_source_idx" ON "acceptance_duty_supersessions" USING btree ("source_id");--> statement-breakpoint
ALTER TABLE "acceptance_duties" ADD CONSTRAINT "acceptance_duties_successor_fk" FOREIGN KEY ("successor_id") REFERENCES "public"."acceptance_duties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acceptance_duties" ADD CONSTRAINT "acceptance_duties_superseded_complete" CHECK (("acceptance_duties"."superseded_at" is null and "acceptance_duties"."superseded_by" is null and "acceptance_duties"."supersede_evidence" is null and "acceptance_duties"."successor_id" is null and "acceptance_duties"."successor_generation" is null) or ("acceptance_duties"."superseded_at" is not null and "acceptance_duties"."superseded_by" is not null and length("acceptance_duties"."supersede_evidence") > 0 and "acceptance_duties"."successor_id" <> "acceptance_duties"."id" and "acceptance_duties"."successor_generation" > 0));
--> statement-breakpoint
DROP TRIGGER IF EXISTS acceptance_duty_supersessions_notify ON acceptance_duty_supersessions;
--> statement-breakpoint
CREATE TRIGGER acceptance_duty_supersessions_notify AFTER INSERT OR UPDATE OR DELETE ON acceptance_duty_supersessions
  FOR EACH ROW EXECUTE FUNCTION fleet_notify_change('id');