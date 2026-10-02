CREATE TABLE "routing_catalog" (
	"source" text NOT NULL,
	"payload" jsonb NOT NULL,
	"commit" text NOT NULL,
	"purposes_version" integer NOT NULL,
	"synced_at" timestamp with time zone NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"last_error" text,
	"status" text NOT NULL,
	CONSTRAINT "routing_catalog_source_pk" PRIMARY KEY("source"),
	CONSTRAINT "routing_catalog_commit_sha" CHECK ("routing_catalog"."commit" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "routing_catalog_status_known" CHECK ("routing_catalog"."status" in ('fresh', 'stale', 'blocked')),
	CONSTRAINT "routing_catalog_payload_shape" CHECK (
        coalesce(jsonb_typeof("routing_catalog"."payload") = 'object', false)
        and coalesce(jsonb_typeof("routing_catalog"."payload" -> 'purposes') = 'object', false)
        and coalesce(jsonb_typeof("routing_catalog"."payload" -> 'models') = 'object', false)
        and coalesce("routing_catalog"."payload" ->> 'formatVersion' = '1', false)
      ),
	CONSTRAINT "routing_catalog_purposes_version_positive" CHECK ("routing_catalog"."purposes_version" >= 1),
	CONSTRAINT "routing_catalog_error_shape" CHECK ("routing_catalog"."last_error" is null or "routing_catalog"."last_error" <> '')
);
