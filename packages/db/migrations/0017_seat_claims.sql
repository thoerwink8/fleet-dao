CREATE TABLE "issue_claims" (
	"repo_id" uuid NOT NULL,
	"issue_number" integer NOT NULL,
	"claim_id" uuid NOT NULL,
	"owner_kind" text NOT NULL,
	"owner_machine" text,
	"owner_label" text,
	"seat_scope" text,
	"seat_term" bigint,
	"state" text NOT NULL,
	"workflow_id" text,
	"pr_numbers" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"grace_minutes" integer NOT NULL,
	"claimed_at" timestamp with time zone NOT NULL,
	"heartbeat_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	"note" text,
	CONSTRAINT "issue_claims_repo_id_issue_number_pk" PRIMARY KEY("repo_id","issue_number"),
	CONSTRAINT "issue_claims_claim_id_unique" UNIQUE("claim_id"),
	CONSTRAINT "issue_claims_issue_number_positive" CHECK ("issue_claims"."issue_number" > 0),
	CONSTRAINT "issue_claims_owner_kind_known" CHECK ("issue_claims"."owner_kind" in ('engine', 'seat', 'worker')),
	CONSTRAINT "issue_claims_state_known" CHECK ("issue_claims"."state" in ('pending_start', 'claimed', 'doing', 'pr_open', 'done', 'released', 'voided')),
	CONSTRAINT "issue_claims_owner_shape" CHECK (case when "issue_claims"."owner_kind" = 'engine' then "issue_claims"."owner_machine" is null and "issue_claims"."owner_label" is null and "issue_claims"."workflow_id" is not null else "issue_claims"."owner_machine" is not null and "issue_claims"."owner_label" is not null end),
	CONSTRAINT "issue_claims_pending_engine_only" CHECK ("issue_claims"."state" <> 'pending_start' or "issue_claims"."owner_kind" = 'engine'),
	CONSTRAINT "issue_claims_ended_shape" CHECK (("issue_claims"."state" in ('done', 'released', 'voided')) = ("issue_claims"."ended_at" is not null)),
	CONSTRAINT "issue_claims_end_reason" CHECK ("issue_claims"."state" not in ('released', 'voided') or coalesce(length("issue_claims"."end_reason"), 0) > 0),
	CONSTRAINT "issue_claims_seat_shape" CHECK (("issue_claims"."seat_scope" is null) = ("issue_claims"."seat_term" is null)),
	CONSTRAINT "issue_claims_grace_positive" CHECK ("issue_claims"."grace_minutes" > 0)
);
--> statement-breakpoint
CREATE TABLE "seat_leases" (
	"scope" text PRIMARY KEY NOT NULL,
	"term" bigint NOT NULL,
	"holder_machine" text NOT NULL,
	"holder_session" text NOT NULL,
	"acquired_at" timestamp with time zone NOT NULL,
	"renewed_at" timestamp with time zone NOT NULL,
	"previous_machine" text,
	"previous_session" text,
	"handoff" text,
	"handoff_at" timestamp with time zone,
	CONSTRAINT "seat_leases_term_positive" CHECK ("seat_leases"."term" > 0),
	CONSTRAINT "seat_leases_scope_known" CHECK ("seat_leases"."scope" = 'main' or "seat_leases"."scope" like 'drill:%'),
	CONSTRAINT "seat_leases_handoff_shape" CHECK (("seat_leases"."handoff" is null) = ("seat_leases"."handoff_at" is null)),
	CONSTRAINT "seat_leases_previous_shape" CHECK (("seat_leases"."previous_machine" is null) = ("seat_leases"."previous_session" is null))
);
--> statement-breakpoint
ALTER TABLE "issue_claims" ADD CONSTRAINT "issue_claims_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_claims_state_heartbeat_idx" ON "issue_claims" USING btree ("state","heartbeat_at");