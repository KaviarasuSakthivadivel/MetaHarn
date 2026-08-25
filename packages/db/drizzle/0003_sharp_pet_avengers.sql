ALTER TABLE "sessions" ADD COLUMN "agent_kind" text DEFAULT 'claude' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "external_session_id" text;