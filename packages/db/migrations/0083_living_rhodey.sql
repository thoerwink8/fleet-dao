CREATE TABLE "quota_window_samples" (
	"pool_id" text NOT NULL,
	"label" text NOT NULL,
	"window" "quota_window_kind" NOT NULL,
	"scope" text DEFAULT '' NOT NULL,
	"utilization" double precision,
	"used" double precision,
	"limit" double precision,
	"unit" "quota_unit" NOT NULL,
	"resets_at" timestamp with time zone,
	"reading" "reading_kind" NOT NULL,
	"read_at" timestamp with time zone NOT NULL,
	CONSTRAINT "quota_window_samples_pool_id_label_read_at_pk" PRIMARY KEY("pool_id","label","read_at"),
	CONSTRAINT "quota_window_samples_label_nonempty" CHECK ("quota_window_samples"."label" <> ''),
	CONSTRAINT "quota_window_samples_utilization_nonneg" CHECK ("quota_window_samples"."utilization" is null or "quota_window_samples"."utilization" >= 0)
);
--> statement-breakpoint
ALTER TABLE "quota_window_samples" ADD CONSTRAINT "quota_window_samples_pool_id_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."pools"("id") ON DELETE no action ON UPDATE no action;