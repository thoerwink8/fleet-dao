CREATE TABLE "route_probe_history" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "route_probe_history_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"route_id" text NOT NULL,
	"probed_at" timestamp with time zone NOT NULL,
	"result" text NOT NULL,
	"duration_ms" integer,
	"failure_reason" text,
	"request_text" text,
	"response_text" text,
	CONSTRAINT "route_probe_history_result_known" CHECK ("route_probe_history"."result" in ('passed', 'failed', 'not_probed')),
	CONSTRAINT "route_probe_history_duration_nonneg" CHECK ("route_probe_history"."duration_ms" is null or "route_probe_history"."duration_ms" >= 0),
	CONSTRAINT "route_probe_history_reason_matches_result" CHECK (("route_probe_history"."result" = 'passed' and "route_probe_history"."failure_reason" is null) or ("route_probe_history"."result" <> 'passed' and coalesce("route_probe_history"."failure_reason", '') <> ''))
);
--> statement-breakpoint
CREATE INDEX "route_probe_history_route_recent_idx" ON "route_probe_history" USING btree ("route_id","probed_at","id");