CREATE TABLE "pool_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"segment" text NOT NULL,
	"route_id" text NOT NULL,
	"reserved_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "pool_reservations_segment_routed" CHECK ("pool_reservations"."segment" in ('manual', 'verify')),
	CONSTRAINT "pool_reservations_expires_after_reserved" CHECK ("pool_reservations"."expires_at" > "pool_reservations"."reserved_at")
);
--> statement-breakpoint
ALTER TABLE "pool_reservations" ADD CONSTRAINT "pool_reservations_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pool_reservations" ADD CONSTRAINT "pool_reservations_route_id_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."routes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pool_reservations_task_segment_uq" ON "pool_reservations" USING btree ("task_id","segment");--> statement-breakpoint
CREATE INDEX "pool_reservations_route_idx" ON "pool_reservations" USING btree ("route_id");