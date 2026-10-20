CREATE TABLE "node_keys" (
	"node_id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "node_keys_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "node_keys_hash_shape" CHECK ("node_keys"."token_hash" ~ '^[0-9a-f]{64}$')
);
