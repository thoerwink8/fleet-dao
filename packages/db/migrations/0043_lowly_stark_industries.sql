CREATE TABLE "channel_model_reads" (
	"channel_id" text PRIMARY KEY NOT NULL,
	"attempted_at" timestamp with time zone NOT NULL,
	"ok" boolean NOT NULL,
	"error_code" text,
	"error_message" text,
	CONSTRAINT "channel_model_reads_error_matches_ok" CHECK (("channel_model_reads"."ok" = true and "channel_model_reads"."error_code" is null and "channel_model_reads"."error_message" is null) or ("channel_model_reads"."ok" = false and coalesce("channel_model_reads"."error_code", '') <> '' and coalesce("channel_model_reads"."error_message", '') <> ''))
);
--> statement-breakpoint
CREATE TABLE "channel_seen_models" (
	"channel_id" text NOT NULL,
	"model_key" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "channel_seen_models_pk" PRIMARY KEY("channel_id","model_key"),
	CONSTRAINT "channel_seen_models_key_nonempty" CHECK (length(btrim("channel_seen_models"."model_key")) > 0),
	CONSTRAINT "channel_seen_models_last_after_first" CHECK ("channel_seen_models"."last_seen_at" >= "channel_seen_models"."first_seen_at")
);
--> statement-breakpoint
ALTER TABLE "channel_model_reads" ADD CONSTRAINT "channel_model_reads_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_seen_models" ADD CONSTRAINT "channel_seen_models_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;