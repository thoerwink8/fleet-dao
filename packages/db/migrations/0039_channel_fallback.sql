CREATE TABLE "channel_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid,
	"task_id" uuid,
	"attempt_idx" bigint NOT NULL,
	"model_id" text NOT NULL,
	"route_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"error_type" text,
	"message" text,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"duration_ms" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_attempts_idx_positive" CHECK ("channel_attempts"."attempt_idx" >= 1),
	CONSTRAINT "channel_attempts_failed_has_reason" CHECK ("channel_attempts"."error_type" is null or coalesce("channel_attempts"."message", '') <> ''),
	CONSTRAINT "channel_attempts_ended_after_start" CHECK ("channel_attempts"."ended_at" >= "channel_attempts"."started_at"),
	CONSTRAINT "channel_attempts_duration_nonneg" CHECK ("channel_attempts"."duration_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "channel_states" (
	"channel_id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"failed_route_id" text,
	"fallback_channel_id" text,
	"fallback_model_id" text,
	"last_probed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"flagged_at" timestamp with time zone,
	CONSTRAINT "channel_states_status_known" CHECK ("channel_states"."status" in ('ok', 'disabled')),
	CONSTRAINT "channel_states_disabled_has_reason" CHECK ("channel_states"."status" = 'ok' or (coalesce("channel_states"."reason", '') <> '' and "channel_states"."flagged_at" is not null)),
	CONSTRAINT "channel_states_fallback_together" CHECK (("channel_states"."fallback_channel_id" is null) = ("channel_states"."fallback_model_id" is null))
);
--> statement-breakpoint
ALTER TABLE "channel_attempts" ADD CONSTRAINT "channel_attempts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_attempts" ADD CONSTRAINT "channel_attempts_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_attempts" ADD CONSTRAINT "channel_attempts_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_attempts" ADD CONSTRAINT "channel_attempts_route_id_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."routes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_attempts" ADD CONSTRAINT "channel_attempts_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_states" ADD CONSTRAINT "channel_states_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_states" ADD CONSTRAINT "channel_states_failed_route_id_routes_id_fk" FOREIGN KEY ("failed_route_id") REFERENCES "public"."routes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_states" ADD CONSTRAINT "channel_states_fallback_channel_id_channels_id_fk" FOREIGN KEY ("fallback_channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_states" ADD CONSTRAINT "channel_states_fallback_model_id_models_id_fk" FOREIGN KEY ("fallback_model_id") REFERENCES "public"."models"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_attempts_task_idx" ON "channel_attempts" USING btree ("task_id","attempt_idx");--> statement-breakpoint
CREATE INDEX "channel_attempts_channel_idx" ON "channel_attempts" USING btree ("channel_id","created_at");