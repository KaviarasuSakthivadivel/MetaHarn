CREATE TABLE "session_dependencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" text NOT NULL,
	"depends_on_session_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
