CREATE TABLE "cli_tool_readings" (
	"scope" text NOT NULL,
	"owner" text NOT NULL,
	"tool" text NOT NULL,
	"installed_version" text,
	"installed_error" text,
	"latest_version" text,
	"latest_error" text,
	"release_versions" jsonb,
	"checked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "cli_tool_readings_pk" PRIMARY KEY("scope","owner","tool"),
	CONSTRAINT "cli_tool_readings_scope_known" CHECK ("cli_tool_readings"."scope" in ('user', 'npm')),
	CONSTRAINT "cli_tool_readings_installed_one" CHECK (("cli_tool_readings"."installed_version" is not null and "cli_tool_readings"."installed_error" is null) or ("cli_tool_readings"."installed_version" is null and coalesce("cli_tool_readings"."installed_error", '') <> '')),
	CONSTRAINT "cli_tool_readings_latest_one" CHECK (("cli_tool_readings"."latest_version" is not null and "cli_tool_readings"."latest_error" is null) or ("cli_tool_readings"."latest_version" is null and coalesce("cli_tool_readings"."latest_error", '') <> ''))
);
