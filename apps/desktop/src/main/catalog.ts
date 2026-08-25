import { randomUUID } from "node:crypto";
import { and, count, eq, isNotNull, isNull, or } from "drizzle-orm";
import { db, orgs, projectWorktrees, repos, sessionDependencies, sessions } from "@metaharn/db";
import type { AgentKind } from "./agents/types.js";

const DEFAULT_ORG_SLUG = "default";

/**
 * v0 has no auth/multi-tenant UI, so every session is catalogued under one
 * implicit "default" org. The schema is already org_id-shaped (see
 * packages/db/src/schema.ts) so Phase 5 (multi-tenant hardening) replaces
 * this lookup with a real auth-derived org, not a schema migration.
 */
export async function ensureOrgAndRepo(repoPath: string) {
  let [org] = await db.select().from(orgs).where(eq(orgs.slug, DEFAULT_ORG_SLUG));
  if (!org) {
    [org] = await db.insert(orgs).values({ name: "Default Org", slug: DEFAULT_ORG_SLUG }).returning();
  }

  let [repo] = await db
    .select()
    .from(repos)
    .where(and(eq(repos.orgId, org.id), eq(repos.localPath, repoPath)));
  if (!repo) {
    const name = repoPath.split("/").filter(Boolean).pop() ?? repoPath;
    [repo] = await db.insert(repos).values({ orgId: org.id, name, localPath: repoPath }).returning();
  }

  return { org, repo };
}

/** Every ACTIVE project registered so far (v0: single default org), for the
 * sidebar — archived projects are filtered out here, at the source, same
 * "filter once, every consumer benefits" pattern listWorktreeRepoIds
 * already established for worktree-linked repos (see ipc.ts's
 * metaharn:listProjects, the one place both filters get applied). */
export async function listRepos() {
  return db.select().from(repos).where(isNull(repos.archivedAt));
}

/** By id, active OR archived — unlike listRepos()/getRepoByLocalPath()
 * below, this deliberately has no archived-filter: removeProject's cascade
 * needs to resolve an archived project's own real localPath too (the
 * "Remove permanently" path out of ProjectsListPage.tsx's Archived
 * section), and listRepos() alone would silently miss it there. */
export async function getRepoById(repoId: string) {
  const [repo] = await db.select().from(repos).where(eq(repos.id, repoId));
  return repo;
}

/** Purely a visibility flag — never touches sessions, worktrees, or
 * anything on disk. The reversible alternative to removeProject below. */
export async function archiveProject(repoId: string): Promise<void> {
  await db.update(repos).set({ archivedAt: new Date() }).where(eq(repos.id, repoId));
}

export async function unarchiveProject(repoId: string): Promise<void> {
  await db.update(repos).set({ archivedAt: null }).where(eq(repos.id, repoId));
}

/** Archived projects only — the mirror image of listRepos' isNull filter,
 * for ProjectsListPage.tsx's collapsible "Archived" section. */
export async function listArchivedRepos() {
  return db.select().from(repos).where(isNotNull(repos.archivedAt));
}

/**
 * Un-registers a project from MetaHarn — deletes its catalog row and its thin
 * session-index rows (which just point at Pi's real transcripts) but never
 * touches the actual folder or Pi's own JSONL session files on disk.
 * `sessions.repoId` has no ON DELETE CASCADE, so it has to go first or the
 * repo delete would fail on the foreign key. Same reasoning for
 * `project_worktrees`: `repoId` can appear on either side of a link (as the
 * worktree itself, or as a parent with worktrees hanging off it), so both
 * directions need clearing before the repo row can go.
 *
 * This only ever deletes DB rows — it deliberately does NOT run any git
 * operation (removing a linked worktree's real checkout) or close any live
 * pty. That orchestration lives in ipc.ts's metaharn:removeProject handler,
 * mirroring exactly how metaharn:removeWorktreeSession already separates "the
 * real git/process side-effects" (ipc.ts, which already imports
 * removeWorktree/closePty) from "the catalog bookkeeping" (this function) —
 * catalog.ts stays a DB-only module, no git.ts/pty-ipc.ts imports here.
 */
export async function removeProject(repoId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.repoId, repoId));
  await db
    .delete(projectWorktrees)
    .where(or(eq(projectWorktrees.repoId, repoId), eq(projectWorktrees.parentRepoId, repoId)));
  await db.delete(repos).where(eq(repos.id, repoId));
}

export interface ProjectDeletionPreview {
  sessionCount: number;
  worktrees: { cwd: string; branch: string }[];
}

/** What removeProject is actually about to destroy, for the confirmation
 * dialog — real counts, not a guess. `sessionCount` covers this repo's OWN
 * sessions only (not its worktrees' — those are surfaced separately via
 * `worktrees`, since each one is itself a real directory/branch on disk,
 * a materially bigger deal than a session row). */
export async function getProjectDeletionPreview(repoId: string): Promise<ProjectDeletionPreview> {
  const [{ value: sessionCount }] = await db
    .select({ value: count() })
    .from(sessions)
    .where(eq(sessions.repoId, repoId));

  const links = await db
    .select({ cwd: repos.localPath, branch: projectWorktrees.branch })
    .from(projectWorktrees)
    .innerJoin(repos, eq(repos.id, projectWorktrees.repoId))
    .where(eq(projectWorktrees.parentRepoId, repoId));

  return { sessionCount, worktrees: links };
}

export async function recordSession(
  sessionId: string,
  orgId: string,
  repoId: string,
  title?: string,
  type: "chat" | "terminal" = "chat",
  agentKind: AgentKind = "claude",
) {
  await db
    .insert(sessions)
    .values({ id: sessionId, orgId, repoId, title, type, agentKind })
    .onConflictDoUpdate({
      target: sessions.id,
      set: { updatedAt: new Date() },
    });
}

/**
 * A terminal session has no Pi transcript to discover on disk (unlike a
 * chat session, which SessionManager.listAll() finds on its own) — this
 * catalog row is the entire record of it existing, which is what lets it
 * show up in session history the same way a chat session does.
 */
export async function createTerminalSession(
  cwd: string,
  agentKind: AgentKind = "claude",
  title?: string,
): Promise<{ id: string }> {
  const { org, repo } = await ensureOrgAndRepo(cwd);
  const id = randomUUID();
  await recordSession(id, org.id, repo.id, title, "terminal", agentKind);
  return { id };
}

/** No file to trash (unlike deleteSession in sessions.ts) — just the catalog row. */
export async function deleteTerminalSession(id: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, id));
}

/**
 * The full row for a terminal session — what pty-ipc.ts needs to resolve
 * which adapter to use and what external id to resume, without the
 * renderer ever having to pass agent internals over IPC itself.
 */
export async function getSessionById(id: string) {
  const [row] = await db.select().from(sessions).where(eq(sessions.id, id));
  return row;
}

/** A session's project directory, resolved via its catalog row's repo join
 * — needed for the worktree-session flow (spawns `git worktree add`
 * relative to the *parent* session's real cwd) and works identically for
 * chat or terminal rows, since both live in the same `sessions` table. */
export async function getSessionCwd(id: string): Promise<string | undefined> {
  const [row] = await db
    .select({ localPath: repos.localPath })
    .from(sessions)
    .innerJoin(repos, eq(sessions.repoId, repos.id))
    .where(eq(sessions.id, id));
  return row?.localPath;
}

/**
 * Records a visual-only "this session's work relates to that one"
 * annotation for the sidebar's minimap — never touches git. De-duplicated
 * at the application level (no unique DB constraint) since this is a
 * small, low-write table and a plain check-then-insert is simplest.
 */
export async function setSessionDependency(sessionId: string, dependsOnSessionId: string): Promise<void> {
  const [existing] = await db
    .select()
    .from(sessionDependencies)
    .where(and(eq(sessionDependencies.sessionId, sessionId), eq(sessionDependencies.dependsOnSessionId, dependsOnSessionId)));
  if (existing) return;
  await db.insert(sessionDependencies).values({ sessionId, dependsOnSessionId });
}

export async function removeSessionDependency(sessionId: string, dependsOnSessionId: string): Promise<void> {
  await db
    .delete(sessionDependencies)
    .where(and(eq(sessionDependencies.sessionId, sessionId), eq(sessionDependencies.dependsOnSessionId, dependsOnSessionId)));
}

/** Every dependency edge across every project — cheap, small table, no
 * pagination needed at this scale; the renderer filters to the current
 * project's sessions itself for the minimap. */
export async function getSessionDependencies(): Promise<{ sessionId: string; dependsOnSessionId: string }[]> {
  return db
    .select({ sessionId: sessionDependencies.sessionId, dependsOnSessionId: sessionDependencies.dependsOnSessionId })
    .from(sessionDependencies);
}

/** Documents that `repoId` is a real `git worktree` checkout of
 * `parentRepoId` — see schema.ts's `projectWorktrees` doc comment for the
 * full reasoning. Called once, right after the worktree's own catalog row
 * is created (`metaharn:createWorktreeSession`, ipc.ts). */
export async function recordWorktree(repoId: string, parentRepoId: string, branch: string): Promise<void> {
  await db.insert(projectWorktrees).values({ repoId, parentRepoId, branch });
}

/** Every repo id that's a worktree of another — used to exclude them from
 * the top-level project list; they're not a separate project. */
export async function listWorktreeRepoIds(): Promise<Set<string>> {
  const rows = await db.select({ repoId: projectWorktrees.repoId }).from(projectWorktrees);
  return new Set(rows.map((r) => r.repoId));
}

/** Resolved to real filesystem paths (not repo ids) since every renderer-side
 * consumer already works purely in terms of `cwd` strings — keeps the
 * renderer from needing to know repo ids exist at all. `branch`/`createdAt`
 * are carried through for ProjectOverview.tsx's WORKTREES section (real git
 * branch + real creation time, not derived/guessed). Small table, no
 * pagination needed at this scale (same reasoning as getSessionDependencies). */
export async function getWorktreeLinks(): Promise<{ cwd: string; parentCwd: string; branch: string; createdAt: Date }[]> {
  const links = await db.select().from(projectWorktrees);
  if (links.length === 0) return [];
  const allRepos = await db.select({ id: repos.id, localPath: repos.localPath }).from(repos);
  const pathById = new Map(allRepos.map((r) => [r.id, r.localPath]));
  return links
    .map((l) => ({
      cwd: pathById.get(l.repoId),
      parentCwd: pathById.get(l.parentRepoId),
      branch: l.branch,
      createdAt: l.createdAt,
    }))
    .filter((l): l is { cwd: string; parentCwd: string; branch: string; createdAt: Date } => Boolean(l.cwd && l.parentCwd));
}

/** A repo's catalog row by its real filesystem path — the worktree-removal
 * flow only knows the real cwd (from ProjectOverview.tsx's WORKTREES
 * cards), not any repo id, so this is the first lookup it needs. */
export async function getRepoByLocalPath(localPath: string) {
  const [repo] = await db.select().from(repos).where(eq(repos.localPath, localPath));
  return repo;
}

/** Resolves a worktree's real PARENT checkout path from its own repoId —
 * `git worktree remove` has to run from a real, valid checkout (the
 * parent's), not from the worktree being removed. `undefined` means
 * `repoId` isn't a linked worktree at all. */
export async function getWorktreeParentCwd(repoId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ parentLocalPath: repos.localPath })
    .from(projectWorktrees)
    .innerJoin(repos, eq(repos.id, projectWorktrees.parentRepoId))
    .where(eq(projectWorktrees.repoId, repoId));
  return row?.parentLocalPath;
}

/** Every session id under a repo — just enough for the worktree-removal
 * flow to close their live ptys before the rows themselves get deleted. */
export async function getSessionIdsByRepoId(repoId: string): Promise<string[]> {
  const rows = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.repoId, repoId));
  return rows.map((r) => r.id);
}

/**
 * Deletes a worktree's own catalog footprint — its sessions, its
 * `project_worktrees` link, and its `repos` row — everything except the
 * real `git worktree` itself, which the caller removes separately (see
 * `git.ts`'s `removeWorktree`, always run BEFORE this so a failed git
 * removal never leaves the DB out of sync with what's actually on disk).
 * Same manual-cascade-order reasoning as `removeProject`.
 */
export async function deleteWorktreeCatalogRows(repoId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.repoId, repoId));
  await db.delete(projectWorktrees).where(eq(projectWorktrees.repoId, repoId));
  await db.delete(repos).where(eq(repos.id, repoId));
}

/**
 * Persists a Codex/Gemini session's real external id once discovered (see
 * agents/codex.ts's discoverExternalSessionId) — Claude never needs this,
 * its id is always resolvable without ever touching this column (see
 * agents/registry.ts's resolveExternalSessionId).
 */
export async function setExternalSessionId(id: string, externalSessionId: string): Promise<void> {
  await db.update(sessions).set({ externalSessionId, updatedAt: new Date() }).where(eq(sessions.id, id));
}

/**
 * Swaps which real CLI agent a terminal session runs, in place — the
 * catalog row keeps its own id/title (same tab, same history-in-this-app
 * sense), but starts fresh under the new agent from here on. Clears
 * externalSessionId: the old agent's session id (if any) has no meaning to
 * a different CLI. Does NOT touch the live pty itself — the caller (see
 * ipc.ts's metaharn:swapTerminalSessionAgent) closes it first.
 */
export async function swapTerminalSessionAgent(id: string, agentKind: AgentKind): Promise<void> {
  await db.update(sessions).set({ agentKind, externalSessionId: null, updatedAt: new Date() }).where(eq(sessions.id, id));
}

/**
 * Auto-titles a terminal session from the first line the user types into
 * it — mirrors how a chat session's title falls back to its first message
 * (see sessionTitle() in format.ts) when nothing more specific has been
 * set. Only called once, for a brand-new terminal session (see
 * TerminalPane.tsx's onFirstInput) — reopening an existing one never calls
 * this, so an already-titled session keeps its title.
 */
export async function renameTerminalSession(id: string, title: string): Promise<void> {
  await db.update(sessions).set({ title, updatedAt: new Date() }).where(eq(sessions.id, id));
}

/**
 * Purely a visibility flag — same archivedAt pattern as archiveProject
 * above, just at the session level. Never touches the real JSONL file (chat)
 * or any live pty (terminal); the reversible alternative to a real delete.
 * A chat session discovered on disk via SessionManager.listAll() but never
 * actually opened through metaharn:init has no catalog row to update yet — a
 * real, if rare, edge case; `.returning()` lets the caller detect that and
 * surface a clear error instead of silently no-op'ing.
 */
export async function archiveSession(id: string): Promise<void> {
  const rows = await db.update(sessions).set({ archivedAt: new Date() }).where(eq(sessions.id, id)).returning({ id: sessions.id });
  if (rows.length === 0) {
    throw new Error(`No catalog row for session ${id} — it may never have been opened through MetaHarn yet.`);
  }
}

export async function unarchiveSession(id: string): Promise<void> {
  await db.update(sessions).set({ archivedAt: null }).where(eq(sessions.id, id));
}

/** Every archived session id, mapped to when it was archived — sessions.ts's
 * listAllSessions() (needs just the id set, to exclude) and
 * listArchivedSessions() (needs the timestamp too, to display) both build
 * off this ONE query, since it's the ONE place archivedAt actually lives;
 * the chat-session disk scan (SessionManager.listAll()) has no concept of
 * it at all. */
export async function listArchivedSessionTimestamps(): Promise<Map<string, Date>> {
  const rows = await db
    .select({ id: sessions.id, archivedAt: sessions.archivedAt })
    .from(sessions)
    .where(isNotNull(sessions.archivedAt));
  return new Map(rows.map((r) => [r.id, r.archivedAt!]));
}

/** Archived TERMINAL sessions only (DB-native — chat sessions need the disk
 * scan too, merged in by sessions.ts's listArchivedSessions()), optionally
 * scoped to one project's cwd. Same shape/join listAllSessions()'s terminal
 * branch already uses, just archivedAt IS NOT NULL instead of IS NULL. */
export async function listArchivedTerminalSessions(cwd?: string) {
  const conditions = [isNotNull(sessions.archivedAt), eq(sessions.type, "terminal")];
  if (cwd) conditions.push(eq(repos.localPath, cwd));
  return db
    .select({
      id: sessions.id,
      title: sessions.title,
      createdAt: sessions.createdAt,
      updatedAt: sessions.updatedAt,
      agentKind: sessions.agentKind,
      archivedAt: sessions.archivedAt,
      localPath: repos.localPath,
    })
    .from(sessions)
    .innerJoin(repos, eq(sessions.repoId, repos.id))
    .where(and(...conditions));
}
