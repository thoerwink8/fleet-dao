CREATE TABLE "session_org_state" (
	"user_name" text PRIMARY KEY NOT NULL,
	"doc" jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"lock_holder" text,
	"lock_until" timestamp with time zone
);
