/**
 * Episodic memory — "what happened," distinct from the semantic tier's "what's true"
 * (sqliteStore.ts). One row per PAST session in a workspace: a short, model-written summary
 * of that session's task and outcome, not a fact the agent was explicitly asked to remember.
 *
 * Write policy: a session graduates into episodic memory once it's no longer the live one —
 * see apps/server/src/session.ts's `summarizeUnsummarizedSessions()`, called (fire-and-forget,
 * best-effort) whenever a NEW session opens in the same workspace, looking back at whichever
 * recent prior sessions there don't have a row here yet. This is the natural unit for episodic
 * memory to write at: a session is one episode, and it's only truly "past" once something else
 * has taken its place as the live one.
 *
 * Retrieval: `listRecent()` — newest first, capped — rendered by `renderEpisodicBlock` (below)
 * into its own system-prompt section, separate from the semantic memories block, since the two
 * answer different questions ("what happened before" vs. "what's known to be true").
 *
 * Decay: `pruneOlderThan()` — recency-bounded retention, not contradiction detection. Episodic
 * memory doesn't need conflict resolution the way a fact does (a later session doesn't
 * "contradict" an earlier one, it just supersedes it in relevance) — bounding by age and count
 * is the honest, implementable policy here, not a claim to have solved memory decay in general.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export interface EpisodicItem {
  id: number;
  workspace: string;
  sessionId: string;
  summary: string;
  messageCount: number;
  createdAt: string;
}

interface EpisodicRow {
  id: number;
  workspace: string;
  session_id: string;
  summary: string;
  message_count: number;
  created_at: string;
}

function rowToItem(row: EpisodicRow): EpisodicItem {
  return {
    id: row.id,
    workspace: row.workspace,
    sessionId: row.session_id,
    summary: row.summary,
    messageCount: row.message_count,
    createdAt: row.created_at,
  };
}

export class SqliteEpisodicStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS episodic_memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace TEXT NOT NULL,
        session_id TEXT NOT NULL UNIQUE,
        summary TEXT NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS episodic_memories_workspace_idx ON episodic_memories(workspace)");
  }

  /** One row per session — `UNIQUE(session_id)` is the completion marker `hasSummary()`
   * reads, so a session is never summarized twice. */
  add(input: { workspace: string; sessionId: string; summary: string; messageCount: number }): EpisodicItem {
    const result = this.db
      .prepare("INSERT INTO episodic_memories (workspace, session_id, summary, message_count) VALUES (?, ?, ?, ?)")
      .run(input.workspace, input.sessionId, input.summary, input.messageCount);
    const row = this.db.prepare("SELECT * FROM episodic_memories WHERE id = ?").get(result.lastInsertRowid) as EpisodicRow;
    return rowToItem(row);
  }

  hasSummary(sessionId: string): boolean {
    const row = this.db.prepare("SELECT 1 FROM episodic_memories WHERE session_id = ?").get(sessionId);
    return row !== undefined;
  }

  listRecent(workspace: string, limit = 10): EpisodicItem[] {
    const rows = this.db
      .prepare("SELECT * FROM episodic_memories WHERE workspace = ? ORDER BY id DESC LIMIT ?")
      .all(workspace, Math.max(1, limit)) as EpisodicRow[];
    return rows.map(rowToItem);
  }

  /** Recency-bounded decay — see module doc for why this, not contradiction detection, is the
   * honest policy for this tier. Returns the number of rows removed. */
  pruneOlderThan(days: number): number {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const result = this.db.prepare("DELETE FROM episodic_memories WHERE created_at < ?").run(cutoff);
    return result.changes;
  }

  close(): void {
    this.db.close();
  }
}
