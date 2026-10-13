CREATE TABLE "github_user_tokens" (
	"user_id" uuid NOT NULL,
	"app_role" text NOT NULL,
	"github_login" text NOT NULL,
	"access_token" text NOT NULL,
	"refresh_token" text,
	"expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_user_tokens_user_id_app_role_pk" PRIMARY KEY("user_id","app_role"),
	CONSTRAINT "github_user_tokens_role_known" CHECK ("github_user_tokens"."app_role" in ('agent', 'engine'))
);
--> statement-breakpoint
ALTER TABLE "github_user_tokens" ADD CONSTRAINT "github_user_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;