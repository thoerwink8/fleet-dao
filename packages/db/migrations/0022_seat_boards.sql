CREATE TABLE "seat_boards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text NOT NULL,
	"project" text NOT NULL,
	"headline" text DEFAULT '' NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"log" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"needs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"answers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "seat_boards_scope_project_unique" UNIQUE("scope","project"),
	CONSTRAINT "seat_boards_scope_known" CHECK ("seat_boards"."scope" = 'main' or "seat_boards"."scope" like 'drill:%'),
	CONSTRAINT "seat_boards_steps_array" CHECK (jsonb_typeof("seat_boards"."steps") = 'array'),
	CONSTRAINT "seat_boards_log_array" CHECK (jsonb_typeof("seat_boards"."log") = 'array'),
	CONSTRAINT "seat_boards_needs_array" CHECK (jsonb_typeof("seat_boards"."needs") = 'array'),
	CONSTRAINT "seat_boards_answers_array" CHECK (jsonb_typeof("seat_boards"."answers") = 'array')
);
--> statement-breakpoint
DROP TRIGGER IF EXISTS seat_boards_notify ON seat_boards;
--> statement-breakpoint
CREATE TRIGGER seat_boards_notify AFTER INSERT OR UPDATE OR DELETE ON seat_boards
  FOR EACH ROW EXECUTE FUNCTION fleet_notify_change('id');
