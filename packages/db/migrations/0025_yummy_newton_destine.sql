CREATE TABLE "routing_catalog" (
	"model_id" text NOT NULL,
	"route_id" text NOT NULL,
	"position" integer NOT NULL,
	"enabled" boolean NOT NULL,
	CONSTRAINT "routing_catalog_model_id_route_id_pk" PRIMARY KEY("model_id","route_id"),
	CONSTRAINT "routing_catalog_model_position_unique" UNIQUE("model_id","position"),
	CONSTRAINT "routing_catalog_position_nonneg" CHECK ("routing_catalog"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "routing_purpose_models" (
	"purpose" "stage_kind" NOT NULL,
	"model_id" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "routing_purpose_models_purpose_model_id_pk" PRIMARY KEY("purpose","model_id"),
	CONSTRAINT "routing_purpose_models_purpose_position_unique" UNIQUE("purpose","position"),
	CONSTRAINT "routing_purpose_models_position_nonneg" CHECK ("routing_purpose_models"."position" >= 0)
);
--> statement-breakpoint
ALTER TABLE "routes" ADD CONSTRAINT "routes_id_model_unique" UNIQUE("id","model_id");--> statement-breakpoint
ALTER TABLE "routing_catalog" ADD CONSTRAINT "routing_catalog_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_catalog" ADD CONSTRAINT "routing_catalog_route_of_model_fk" FOREIGN KEY ("route_id","model_id") REFERENCES "public"."routes"("id","model_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_purpose_models" ADD CONSTRAINT "routing_purpose_models_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE no action ON UPDATE no action;
