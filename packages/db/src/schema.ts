import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";

export const orgs = pgTable("orgs", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const repos = pgTable("repos", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => orgs.id),
  name: text("name").notNull(),
  // v0: repos are indexed by local filesystem path. Phase 2 replaces this
  // with a GitHub App installation + remote clone, at which point this
  // becomes one of several source locators rather than the only one.
  localPath: text("local_path").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  // null = active (the normal state). A real timestamp means the user
  // archived it — hidden from the top-level project list (same
  // filter-at-the-source pattern as project_worktrees' repoId exclusion
  // below) but not deleted: nothing on disk or in the DB is touched by
  // archiving, only by an explicit removeProject call.
  archivedAt: timestamp("archived_at"),
});

export const sessions = pgTable("sessions", {
  // For type "chat": mirrors the session id Pi's own SessionManager assigns
  // — this row is a catalog/index row (org + repo -> session), not the
  // transcript store; Pi persists the actual transcript itself. For type
  // "terminal": MetaHarn-generated (crypto.randomUUID()) — a terminal has no
  // Pi transcript at all, so this row IS the entire record of it existing.
  id: text("id").primaryKey(),
  orgId: uuid("org_id").notNull().references(() => orgs.id),
  repoId: uuid("repo_id").notNull().references(() => repos.id),
  title: text("title"),
  type: text("type").notNull().default("chat"), // "chat" | "terminal"
  // Only meaningful for type "terminal" — which real CLI this session runs
  // ("claude" | "codex" | "gemini", see apps/desktop/src/main/agents/).
  // Defaulting to "claude" backfills every pre-existing terminal row for
  // free at column-add time (mirrors the `type` column's own precedent) —
  // every terminal session before this column existed was a Claude one.
  agentKind: text("agent_kind").notNull().default("claude"),
  // The agent CLI's own session id, when it differs from this row's own
  // `id`. Claude can be told its id upfront (--session-id), so this stays
  // null for Claude rows — resolveExternalSessionId() in agents/registry.ts
  // falls back to `id` for them. Codex/Gemini generate their own id, only
  // discoverable after the first real exchange, so this is populated later
  // (or never, for Gemini — see agents/gemini.ts).
  externalSessionId: text("external_session_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  // null = active (the normal state). A real timestamp means the user
  // archived it — hidden from the normal session list (listAllSessions)
  // but not deleted: no file, no pty, nothing else is touched by
  // archiving, only by an explicit deleteSession/deleteTerminalSession
  // call. Same archivedAt pattern as repos.archivedAt above, just at the
  // session level instead of the project level.
  archivedAt: timestamp("archived_at"),
});

// A visual-only "this session's work relates to that one" annotation shown
// in the sidebar's minimap — deliberately NOT a git relationship. Setting
// one never touches branches/rebases/PRs; for real stacked-branch
// management, a dedicated tool (e.g. Stackinator) is the right layer for
// that, not this table. Plain `text`, no FK to sessions.id: chat-session
// ids live in Pi's own transcript store, not exclusively this table, so a
// hard FK isn't valid for every row the way it would be for terminal-only
// data (same reasoning already applies to how `sessions` itself is used).
export const sessionDependencies = pgTable("session_dependencies", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: text("session_id").notNull(),
  dependsOnSessionId: text("depends_on_session_id").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Documents that a `repos` row is a real `git worktree` checkout of another
// `repos` row, not a project in its own right. `repoId` still has to be a
// real repos row — `sessions.cwd` is always resolved via
// `sessions.repoId -> repos.localPath` (see sessions.ts's listAllSessions()),
// and a worktree checkout genuinely lives at a different filesystem path
// than its parent, so it needs its own row for that path to resolve at all.
// What this table changes is purely presentational: `repoId` gets excluded
// from the top-level project list (listProjects, ipc.ts) and its sessions
// get grouped into `parentRepoId`'s Sidebar card list instead of forming
// their own. It does not make the worktree real — main/worktree.ts's actual
// `git worktree add` call already did that before this table gets a row.
export const projectWorktrees = pgTable("project_worktrees", {
  id: uuid("id").primaryKey().defaultRandom(),
  repoId: uuid("repo_id").notNull().references(() => repos.id),
  parentRepoId: uuid("parent_repo_id").notNull().references(() => repos.id),
  branch: text("branch").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
