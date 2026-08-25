CREATE TABLE "project_worktrees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"parent_repo_id" uuid NOT NULL,
	"branch" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_worktrees" ADD CONSTRAINT "project_worktrees_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_worktrees" ADD CONSTRAINT "project_worktrees_parent_repo_id_repos_id_fk" FOREIGN KEY ("parent_repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;