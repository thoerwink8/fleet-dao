CREATE TABLE "fleet2"."jobs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"queue" text NOT NULL,
	"key" text NOT NULL,
	"parent_key" text,
	"payload" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"due_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deadline_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"lease_until" timestamp with time zone,
	"claim_token" text,
	"claimed_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_key_unique" UNIQUE("key"),
	CONSTRAINT "jobs_state_known" CHECK ("fleet2"."jobs"."state" in ('pending', 'claimed', 'done', 'cancelled', 'dead')),
	CONSTRAINT "jobs_claim_fields" CHECK (("fleet2"."jobs"."state" = 'claimed') = ("fleet2"."jobs"."lease_until" is not null and "fleet2"."jobs"."claim_token" is not null)),
	CONSTRAINT "jobs_attempts_range" CHECK ("fleet2"."jobs"."attempts" >= 0 and "fleet2"."jobs"."max_attempts" >= 1)
);
--> statement-breakpoint
CREATE TABLE "fleet2"."queue_limits" (
	"queue" text PRIMARY KEY NOT NULL,
	"max_inflight" integer NOT NULL,
	"per_minute" integer NOT NULL,
	CONSTRAINT "queue_limits_positive" CHECK ("fleet2"."queue_limits"."max_inflight" > 0 and "fleet2"."queue_limits"."per_minute" > 0)
);
--> statement-breakpoint
CREATE INDEX "jobs_due_idx" ON "fleet2"."jobs" USING btree ("queue","due_at") WHERE "fleet2"."jobs"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "jobs_lease_idx" ON "fleet2"."jobs" USING btree ("lease_until") WHERE "fleet2"."jobs"."state" = 'claimed';--> statement-breakpoint
CREATE INDEX "jobs_claimed_at_idx" ON "fleet2"."jobs" USING btree ("queue","claimed_at");--> statement-breakpoint
CREATE INDEX "jobs_parent_idx" ON "fleet2"."jobs" USING btree ("parent_key") WHERE "fleet2"."jobs"."parent_key" is not null;