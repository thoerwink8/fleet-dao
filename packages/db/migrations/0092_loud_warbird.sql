CREATE TABLE "private_quotes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"spoken_at" timestamp with time zone NOT NULL,
	"text" text NOT NULL,
	"machine" text NOT NULL,
	"lineage" text NOT NULL,
	"remote" text,
	"directive_id" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "private_quotes_spoken_at_idx" ON "private_quotes" USING btree ("spoken_at","id");