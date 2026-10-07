CREATE TABLE "task_route_pins" (
	"task_id" uuid NOT NULL,
	"segment" text NOT NULL,
	"model_id" text,
	"route_id" text,
	"set_by" text NOT NULL,
	"set_at" timestamp with time zone NOT NULL,
	"reason" text,
	CONSTRAINT "task_route_pins_pk" PRIMARY KEY("task_id","segment"),
	CONSTRAINT "task_route_pins_segment_routed" CHECK ("task_route_pins"."segment" in ('manual', 'verify')),
	CONSTRAINT "task_route_pins_route_needs_model" CHECK ("task_route_pins"."route_id" is null or "task_route_pins"."model_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "task_route_pins" ADD CONSTRAINT "task_route_pins_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_route_pins" ADD CONSTRAINT "task_route_pins_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_route_pins" ADD CONSTRAINT "task_route_pins_route_of_model_fk" FOREIGN KEY ("route_id","model_id") REFERENCES "public"."routes"("id","model_id") ON DELETE no action ON UPDATE no action;