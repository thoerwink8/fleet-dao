-- 记账表 fleet2.__migrations 由迁移器先建，schema 那时已经在了：这里要 IF NOT EXISTS
CREATE SCHEMA IF NOT EXISTS "fleet2";
--> statement-breakpoint
CREATE TABLE "fleet2"."command_receipts" (
	"key" text PRIMARY KEY NOT NULL,
	"command" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fleet2"."events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"stream_id" text NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"schema_version" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_stream_seq_unique" UNIQUE("stream_id","seq"),
	CONSTRAINT "events_seq_positive" CHECK ("fleet2"."events"."seq" > 0)
);
--> statement-breakpoint
CREATE TABLE "fleet2"."outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"op_key" text NOT NULL,
	"kind" text NOT NULL,
	"repo" text NOT NULL,
	"issue" integer NOT NULL,
	"fencing" bigint NOT NULL,
	"payload" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"claim_token" text,
	"result" jsonb,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_op_key_unique" UNIQUE("op_key"),
	CONSTRAINT "outbox_state_known" CHECK ("fleet2"."outbox"."state" in ('pending', 'claimed', 'done', 'unknown', 'dead')),
	CONSTRAINT "outbox_claim_fields" CHECK (("fleet2"."outbox"."state" = 'claimed') = ("fleet2"."outbox"."lease_until" is not null and "fleet2"."outbox"."claim_token" is not null))
);
--> statement-breakpoint
CREATE TABLE "fleet2"."projection_checkpoints" (
	"name" text PRIMARY KEY NOT NULL,
	"last_event_id" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fleet2"."stream_heads" (
	"stream_id" text PRIMARY KEY NOT NULL,
	"head_seq" integer NOT NULL,
	"last_type" text NOT NULL,
	"events" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX "outbox_due_idx" ON "fleet2"."outbox" USING btree ("next_at") WHERE "fleet2"."outbox"."state" in ('pending', 'unknown');