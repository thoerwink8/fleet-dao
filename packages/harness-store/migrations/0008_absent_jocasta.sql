CREATE TABLE "fleet2"."ade_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"parent_id" text,
	"task_id" integer,
	"agent" text NOT NULL,
	"model" text NOT NULL,
	"worktree" boolean NOT NULL,
	"cwd" text NOT NULL,
	"title" text NOT NULL,
	"status" text NOT NULL,
	"hold" boolean DEFAULT false NOT NULL,
	"queue" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"run_id" text,
	"agent_session_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ade_sessions_status" CHECK ("fleet2"."ade_sessions"."status" in ('idle', 'running'))
);
--> statement-breakpoint
CREATE TABLE "fleet2"."ade_tasks" (
	"id" integer PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"source" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ade_tasks_status" CHECK ("fleet2"."ade_tasks"."status" in ('open', 'closed'))
);
--> statement-breakpoint
CREATE TABLE "fleet2"."ade_workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"path" text NOT NULL,
	"is_git" boolean NOT NULL,
	"forge" text NOT NULL,
	"remote" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ade_workspaces_path_unique" UNIQUE("path"),
	CONSTRAINT "ade_workspaces_forge" CHECK ("fleet2"."ade_workspaces"."forge" in ('github', 'gitlab', 'local'))
);
--> statement-breakpoint
CREATE INDEX "ade_sessions_workspace_idx" ON "fleet2"."ade_sessions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "ade_sessions_parent_idx" ON "fleet2"."ade_sessions" USING btree ("parent_id") WHERE "fleet2"."ade_sessions"."parent_id" is not null;--> statement-breakpoint
CREATE INDEX "ade_tasks_workspace_idx" ON "fleet2"."ade_tasks" USING btree ("workspace_id","id");