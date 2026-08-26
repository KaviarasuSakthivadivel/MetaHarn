/**
 * The Inbox — the durable, cross-restart human-attention queue.
 *
 * While a session is Unattended (unattended.ts), anything that would normally prompt inline
 * (an approval, a question from tools-interactive's `ask_user`) is parked here instead and the
 * agent suspends until it's resolved — from any surface, at any later time, even after this
 * process restarts. Backed by SQLite (via better-sqlite3) rather than the JSON file
 * OpenWorker's coworker/inbox.py uses, since a JSON-file-per-write doesn't hold up under
 * concurrent resolution attempts the way SQLite's row-level atomicity does.
 *
 * State machine: each item is pending -> resolved, resolved *once* — resolve() is
 * idempotent and first-responder-wins, so answering from the in-app composer after a resume
 * races safely against answering from, say, a mirrored Slack message. `wait()` is how an
 * Approver or a question-asking tool suspends the agent until a human answers; resolve()
 * fires any in-process waiter via a plain in-memory map (not itself durable — a waiter lost to
 * a restart is expected to re-`wait()` the still-pending row after resuming, which the durable
 * `resolved` flag makes safe to do unconditionally).
 *
 * Deliberate simplification vs. the full inbox.py: no `visibility` (inline vs inbox) or named
 * `inbox` routing fields — those are Phase-3 multi-channel-delivery concerns for OpenWorker
 * that have no consumer here yet. See the module docstring in unattended.ts for how the
 * attended/unattended split is expected to gate routing instead: the caller decides whether to
 * park an item here at all.
 */
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type { ApprovalOutcome, Approver, PermissionRequest } from "../types.js";

export type InboxItemKind = "approval" | "question";

/** A question's choice: a bare label, or a rich option with a description/recommended flag
 * (mirrors OpenWorker's ask_user options — old plain-string items keep working). */
export type InboxOption = string | { label: string; description?: string; recommended?: boolean };

/** One entry of a grouped multi-question ask (OpenWorker's OPE-51): several sub-questions
 * resolved together as a single item. */
export interface InboxQuestion {
  question: string;
  header?: string;
  options?: InboxOption[];
  allowText?: boolean;
  multi?: boolean;
}

export interface InboxItem {
  id: string;
  kind: InboxItemKind;
  sessionId: string;
  /** The tool call this item is blocking, if any — the idempotency key: a durable resume
   * re-raising the same ask reuses the existing item (add() dedupes on it) instead of
   * prompting twice. */
  toolCallId?: string;
  toolName?: string;
  arguments?: Record<string, unknown>;
  title?: string;
  body?: string;
  options?: InboxOption[];
  questions?: InboxQuestion[];
  resolved: boolean;
  /** approval: "allow" | "always" | "deny"; question: the answer text (or option label). */
  resolution?: string;
  createdAt: number;
  resolvedAt?: number;
}

export interface AddInboxItemInput {
  sessionId: string;
  kind: InboxItemKind;
  toolCallId?: string;
  toolName?: string;
  arguments?: Record<string, unknown>;
  title?: string;
  body?: string;
  options?: InboxOption[];
  questions?: InboxQuestion[];
}

export interface InboxListFilter {
  sessionId?: string;
  kind?: InboxItemKind;
  resolved?: boolean;
}

/** The label to render for an option, whether it's a bare string or a rich {label, ...}. */
export function optionLabel(option: InboxOption): string {
  return typeof option === "string" ? option : option.label;
}

interface InboxRow {
  id: string;
  kind: string;
  sessionId: string;
  toolCallId: string | null;
  toolName: string | null;
  arguments: string | null;
  title: string | null;
  body: string | null;
  options: string | null;
  questions: string | null;
  resolved: number;
  resolution: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

function rowToItem(row: InboxRow): InboxItem {
  return {
    id: row.id,
    kind: row.kind as InboxItemKind,
    sessionId: row.sessionId,
    toolCallId: row.toolCallId ?? undefined,
    toolName: row.toolName ?? undefined,
    arguments: row.arguments !== null ? (JSON.parse(row.arguments) as Record<string, unknown>) : undefined,
    title: row.title ?? undefined,
    body: row.body ?? undefined,
    options: row.options !== null ? (JSON.parse(row.options) as InboxOption[]) : undefined,
    questions: row.questions !== null ? (JSON.parse(row.questions) as InboxQuestion[]) : undefined,
    resolved: Boolean(row.resolved),
    resolution: row.resolution ?? undefined,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt ?? undefined,
  };
}

/** better-sqlite3 rejects `undefined` bind params outright — every optional field must go in
 * as `null`, and object fields must already be JSON text. */
function itemToRow(item: InboxItem): InboxRow {
  return {
    id: item.id,
    kind: item.kind,
    sessionId: item.sessionId,
    toolCallId: item.toolCallId ?? null,
    toolName: item.toolName ?? null,
    arguments: item.arguments !== undefined ? JSON.stringify(item.arguments) : null,
    title: item.title ?? null,
    body: item.body ?? null,
    options: item.options !== undefined ? JSON.stringify(item.options) : null,
    questions: item.questions !== undefined ? JSON.stringify(item.questions) : null,
    resolved: item.resolved ? 1 : 0,
    resolution: item.resolution ?? null,
    createdAt: item.createdAt,
    resolvedAt: item.resolvedAt ?? null,
  };
}

export class InboxStore {
  private readonly db: Database.Database;
  private readonly insertStmt: Database.Statement<[InboxRow]>;
  /** In-memory only — a waiter lost across a restart re-`wait()`s the durable row instead. */
  private readonly waiters = new Map<string, Array<(resolution: string) => void>>();

  constructor(dbPath: string = ":memory:") {
    this.db = new Database(dbPath);
    if (dbPath !== ":memory:") this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS inbox_items (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        sessionId TEXT NOT NULL,
        toolCallId TEXT,
        toolName TEXT,
        arguments TEXT,
        title TEXT,
        body TEXT,
        options TEXT,
        questions TEXT,
        resolved INTEGER NOT NULL DEFAULT 0,
        resolution TEXT,
        createdAt INTEGER NOT NULL,
        resolvedAt INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_inbox_session ON inbox_items (sessionId);
      CREATE INDEX IF NOT EXISTS idx_inbox_toolcall ON inbox_items (sessionId, toolCallId);
    `);
    this.insertStmt = this.db.prepare(`
      INSERT INTO inbox_items
        (id, kind, sessionId, toolCallId, toolName, arguments, title, body, options, questions, resolved, resolution, createdAt, resolvedAt)
      VALUES
        (@id, @kind, @sessionId, @toolCallId, @toolName, @arguments, @title, @body, @options, @questions, @resolved, @resolution, @createdAt, @resolvedAt)
    `);
  }

  /** Add an item. Idempotent by (sessionId, toolCallId) when a toolCallId is given: a durable
   * resume re-raising the same ask reuses the existing (possibly already-resolved) item rather
   * than parking a duplicate. */
  add(input: AddInboxItemInput): InboxItem {
    if (input.toolCallId) {
      const existing = this.forToolCall(input.sessionId, input.toolCallId);
      if (existing) return existing;
    }
    const item: InboxItem = {
      id: randomUUID(),
      kind: input.kind,
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      arguments: input.arguments,
      title: input.title,
      body: input.body,
      options: input.options,
      questions: input.questions,
      resolved: false,
      createdAt: Date.now(),
    };
    this.insertStmt.run(itemToRow(item));
    return item;
  }

  addApproval(input: {
    sessionId: string;
    toolCallId?: string;
    toolName: string;
    arguments?: Record<string, unknown>;
    title?: string;
    body?: string;
  }): InboxItem {
    return this.add({ ...input, kind: "approval" });
  }

  addQuestion(input: {
    sessionId: string;
    toolCallId?: string;
    title?: string;
    body?: string;
    options?: InboxOption[];
    questions?: InboxQuestion[];
  }): InboxItem {
    return this.add({ ...input, kind: "question" });
  }

  get(id: string): InboxItem | undefined {
    const row = this.db.prepare("SELECT * FROM inbox_items WHERE id = ?").get(id) as InboxRow | undefined;
    return row ? rowToItem(row) : undefined;
  }

  forToolCall(sessionId: string, toolCallId: string): InboxItem | undefined {
    const row = this.db
      .prepare("SELECT * FROM inbox_items WHERE sessionId = ? AND toolCallId = ?")
      .get(sessionId, toolCallId) as InboxRow | undefined;
    return row ? rowToItem(row) : undefined;
  }

  list(filter: InboxListFilter = {}): InboxItem[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.sessionId !== undefined) {
      clauses.push("sessionId = @sessionId");
      params.sessionId = filter.sessionId;
    }
    if (filter.kind !== undefined) {
      clauses.push("kind = @kind");
      params.kind = filter.kind;
    }
    if (filter.resolved !== undefined) {
      clauses.push("resolved = @resolved");
      params.resolved = filter.resolved ? 1 : 0;
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM inbox_items ${where} ORDER BY createdAt ASC`).all(params) as InboxRow[];
    return rows.map(rowToItem);
  }

  /** Convenience over list() — every still-open item, optionally scoped to one session. */
  pending(sessionId?: string): InboxItem[] {
    return sessionId !== undefined ? this.list({ sessionId, resolved: false }) : this.list({ resolved: false });
  }

  /** Resolve an item exactly once. First responder wins; later attempts are no-ops (return
   * false). Fires any in-process waiter (the suspended Approver / ask_user call). */
  resolve(itemId: string, resolution: string): boolean {
    const row = this.db.prepare("SELECT resolved FROM inbox_items WHERE id = ?").get(itemId) as
      | { resolved: number }
      | undefined;
    if (!row || row.resolved) return false;
    this.db
      .prepare("UPDATE inbox_items SET resolved = 1, resolution = @resolution, resolvedAt = @resolvedAt WHERE id = @id")
      .run({ id: itemId, resolution, resolvedAt: Date.now() });
    const waiting = this.waiters.get(itemId);
    if (waiting) {
      this.waiters.delete(itemId);
      for (const notify of waiting) notify(resolution);
    }
    return true;
  }

  /** Resolve every still-pending item of a session (call when the session is deleted — an
   * orphaned approval/question can never be meaningfully answered). Returns how many closed. */
  resolveSession(sessionId: string, resolution = "session deleted"): number {
    let closed = 0;
    for (const item of this.pending(sessionId)) {
      if (this.resolve(item.id, resolution)) closed++;
    }
    return closed;
  }

  /** Await an item's resolution; resolves with the resolution string (used by an Approver / a
   * question-asking tool to suspend until a human answers, from any surface). Passing `signal`
   * lets the caller's own cancellation (e.g. Engine.requestInterrupt's AbortSignal) abort the
   * wait without resolving the underlying item — the row stays pending for a later resume. */
  wait(itemId: string, signal?: AbortSignal): Promise<string> {
    const existing = this.get(itemId);
    if (existing?.resolved) return Promise.resolve(existing.resolution ?? "");
    if (signal?.aborted) return Promise.reject(new Error("aborted"));

    return new Promise<string>((resolve, reject) => {
      const notify = (resolution: string): void => {
        signal?.removeEventListener("abort", onAbort);
        resolve(resolution);
      };
      const onAbort = (): void => {
        const list = this.waiters.get(itemId);
        if (list) {
          const i = list.indexOf(notify);
          if (i !== -1) list.splice(i, 1);
          if (list.length === 0) this.waiters.delete(itemId);
        }
        reject(new Error("aborted"));
      };
      const list = this.waiters.get(itemId);
      if (list) list.push(notify);
      else this.waiters.set(itemId, [notify]);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  close(): void {
    this.db.close();
  }
}

/**
 * An Approver that routes a permission request to the Inbox and suspends until resolved —
 * ported from OpenWorker's `inbox_approver` (bottom of coworker/inbox.py). Wire this in as the
 * Engine's `approver` for a session UnattendedRegistry flags unattended; an attended session
 * should keep using its own inline approver instead.
 */
export function inboxApprover(store: InboxStore, sessionId: string): Approver {
  return async (request: PermissionRequest): Promise<ApprovalOutcome> => {
    const item = store.addApproval({
      sessionId,
      toolCallId: request.toolCallId,
      toolName: request.toolName,
      arguments: request.arguments,
      title: `Run \`${request.toolName}\`?`,
      body: request.reason,
    });
    const resolution = await store.wait(item.id);
    if (resolution === "always") return "always_tool";
    if (resolution === "allow") return "once";
    return "deny";
  };
}
