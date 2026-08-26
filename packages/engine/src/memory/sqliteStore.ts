/**
 * SQLite-backed memory store (the default adapter). Ported from OpenWorker's
 * coworker/memory/sqlite_store.py.
 *
 * Deviation from the Python: no threading.RLock guard around the connection. That lock
 * exists there because the Python server can hit the store from a worker thread other
 * than the one that created it; here the whole engine runs on one Node event loop and
 * better-sqlite3's calls are synchronous (blocking, not interleaved), so there's no
 * concurrent-access window to guard against.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type {
  MemoryAddOptions,
  MemoryDeleteAllFilter,
  MemoryItem,
  MemoryListFilter,
  MemoryStore,
  MemoryUpdateOptions,
  Scope,
} from "./types.js";

interface MemoryRow {
  id: number;
  scope: string;
  key: string | null;
  content: string;
  summary: string | null;
  workspace: string | null;
  session_id: string | null;
  created_at: string;
}

function rowToItem(row: MemoryRow): MemoryItem {
  return {
    id: row.id,
    scope: row.scope as Scope,
    content: row.content,
    key: row.key ?? undefined,
    summary: row.summary ?? undefined,
    workspace: row.workspace ?? undefined,
    sessionId: row.session_id ?? undefined,
    createdAt: row.created_at,
  };
}

export class SqliteMemoryStore implements MemoryStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new Database(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL,
        key TEXT,
        content TEXT NOT NULL,
        summary TEXT,
        workspace TEXT,
        session_id TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // Databases created before the summary column existed: rows without one fall back to
    // a truncated first line of content at render time (memory/types.ts's indexLine) —
    // no data migration needed beyond adding the column.
    const cols = this.db.pragma("table_info(memories)") as Array<{ name: string }>;
    if (!cols.some((col) => col.name === "summary")) {
      this.db.exec("ALTER TABLE memories ADD COLUMN summary TEXT");
    }
  }

  add(content: string, opts: MemoryAddOptions = {}): MemoryItem {
    const scope: Scope = opts.scope ?? "workspace";
    const result = this.db
      .prepare(
        "INSERT INTO memories (scope, key, content, summary, workspace, session_id) " +
          "VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        scope,
        opts.key ?? null,
        content,
        opts.summary ?? null,
        opts.workspace ?? null,
        opts.sessionId ?? null,
      );
    const item = this.get(Number(result.lastInsertRowid));
    if (!item) throw new Error("failed to read back a just-inserted memory");
    return item;
  }

  get(id: number): MemoryItem | undefined {
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as
      | MemoryRow
      | undefined;
    return row ? rowToItem(row) : undefined;
  }

  list(filter: MemoryListFilter = {}): MemoryItem[] {
    let query = "SELECT * FROM memories WHERE 1 = 1";
    const params: unknown[] = [];
    if (filter.scope !== undefined) {
      query += " AND scope = ?";
      params.push(filter.scope);
    }
    if (filter.workspace !== undefined) {
      query += " AND workspace = ?";
      params.push(filter.workspace);
    }
    if (filter.sessionId !== undefined) {
      query += " AND session_id = ?";
      params.push(filter.sessionId);
    }
    query += " ORDER BY id";
    const rows = this.db.prepare(query).all(...params) as MemoryRow[];
    return rows.map(rowToItem);
  }

  update(id: number, content: string, opts: MemoryUpdateOptions = {}): MemoryItem | undefined {
    if (opts.summary !== undefined) {
      this.db
        .prepare("UPDATE memories SET content = ?, summary = ? WHERE id = ?")
        .run(content, opts.summary, id);
    } else {
      this.db.prepare("UPDATE memories SET content = ? WHERE id = ?").run(content, id);
    }
    return this.get(id);
  }

  delete(id: number): boolean {
    const result = this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
    return result.changes > 0;
  }

  deleteAll(filter: MemoryDeleteAllFilter = {}): number {
    const result =
      filter.scope !== undefined
        ? this.db.prepare("DELETE FROM memories WHERE scope = ?").run(filter.scope)
        : this.db.prepare("DELETE FROM memories").run();
    return result.changes;
  }

  /**
   * Re-key workspace-scoped memories from one project identifier to another (e.g. a
   * workspace-path key migrating to a git-remote identity). Rows are independent, so a
   * collision with existing rows already under `newKey` is just a union. Returns the
   * number of rows moved.
   */
  rekeyWorkspace(oldKey: string, newKey: string): number {
    if (oldKey === newKey) return 0;
    const result = this.db
      .prepare("UPDATE memories SET workspace = ? WHERE workspace = ? AND scope = 'workspace'")
      .run(newKey, oldKey);
    return result.changes;
  }

  close(): void {
    this.db.close();
  }
}
