-- #1990：只建两张新表，不改不删已有的。worktree_inventory 存法国工作树最近一份清单（#1993，引擎写、后端读）；
-- node_sessions 存创始人电脑推来的本机会话心跳（#1991，一个环境一行、覆盖写）。
CREATE TABLE "node_sessions" (
	"node_id" text PRIMARY KEY NOT NULL,
	"schema_version" integer NOT NULL,
	"reported_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worktree_inventory" (
	"key" text PRIMARY KEY NOT NULL,
	"taken_at" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL
);
