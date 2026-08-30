/**
 * Memory — the long-lived layer above transient conversation state: durable facts,
 * preferences, task notes, summaries. Two persisted scopes: "global" (user-wide) and
 * "workspace" (per project). Backends are adapters (sqliteStore.ts's SqliteMemoryStore
 * now, a Postgres one later) implementing the MemoryStore contract below.
 *
 * OpenWorker's Python source (coworker/memory/base.py) has a third enum member,
 * Scope.SESSION — but nothing there ever reads or writes it (spec §3: a dead scope kept
 * only so `remember`'s scope argument can reject it explicitly). Rather than port a value
 * this type can never actually hold, it's dropped from the Scope union entirely; the
 * `remember` tool (tools.ts) still accepts the raw string "session" from a model and
 * silently redirects it to "workspace", matching the Python's behavior exactly.
 *
 * Ported from OpenWorker's coworker/memory/base.py.
 */

export type Scope = "global" | "workspace";

export interface MemoryItem {
  id: number;
  scope: Scope;
  content: string;
  key?: string;
  summary?: string;
  workspace?: string;
  sessionId?: string;
  createdAt?: string;
}

export interface MemoryAddOptions {
  scope?: Scope;
  key?: string;
  summary?: string;
  workspace?: string;
  sessionId?: string;
}

export interface MemoryListFilter {
  scope?: Scope;
  workspace?: string;
  sessionId?: string;
}

export interface MemoryUpdateOptions {
  summary?: string;
}

export interface MemoryDeleteAllFilter {
  scope?: Scope;
}

/**
 * Storage adapter contract. Deliberately synchronous, mirroring the Python ABC (whose
 * concrete SQLite adapter is itself synchronous, guarded by a lock rather than async) —
 * better-sqlite3 is synchronous end to end, so there is no I/O to await here. A future
 * backend that genuinely needs to await (e.g. Postgres over the network) wraps its own
 * calls on its side rather than this interface growing Promises everywhere a local store
 * doesn't need them.
 */
export interface MemoryStore {
  add(content: string, opts?: MemoryAddOptions): MemoryItem;
  get(id: number): MemoryItem | undefined;
  list(filter?: MemoryListFilter): MemoryItem[];
  update(id: number, content: string, opts?: MemoryUpdateOptions): MemoryItem | undefined;
  delete(id: number): boolean;
  deleteAll(filter?: MemoryDeleteAllFilter): number;
}

// ---------------------------------------------------------------------------------------
// Rendering — the injected "known memories" system-prompt block (MEMORY-SPEC §7)
// ---------------------------------------------------------------------------------------

/**
 * Below this rendered size, every memory is injected in full; above it, the block flips
 * to index mode (newest few in full, one-line summaries for the rest, bodies fetched on
 * demand via the memory_read tool). ~8k chars: a typical memory is 20-40 tokens, so this
 * only trips past ~50-100 memories — and the weakest supported setup (a local model with
 * an 8k context) binds the ceiling.
 */
export const INDEX_THRESHOLD_CHARS = 8_000;

/**
 * In index mode the newest N stay in full: recent facts are disproportionately relevant,
 * which softens the two-step recall cost (summary now, memory_read later) where it
 * matters most.
 */
export const INDEX_FULL_NEWEST = 10;

const INDEX_NOTE =
  "(Some memories above show only a one-line summary. Call memory_read with the " +
  "[#id]s before acting on anything a summary hints at.)";

/**
 * One-line rendering: the saved summary, or a truncated first line for rows written
 * before summaries existed (no data migration needed for those).
 */
function indexLine(item: MemoryItem): string {
  let text = (item.summary ?? "").trim();
  if (!text) {
    const trimmedContent = item.content.trim();
    text = trimmedContent ? trimmedContent.split("\n")[0] : "";
    if (text.length > 80) text = text.slice(0, 77) + "...";
  }
  return `- [#${item.id}] ${text}`;
}

/**
 * Render memories in full for injection into the system prompt. Ids are shown so the
 * agent can revise a memory (memory_update) or retire it (memory_forget).
 */
export function formatMemories(items: MemoryItem[]): string {
  if (items.length === 0) return "";
  const lines = items.map((item) => `- [#${item.id}] ${item.content}`);
  return "Known memories (from earlier sessions):\n" + lines.join("\n");
}

/**
 * Index rendering: newest `fullNewest` in full, one-line summaries for the rest, plus the
 * fetch-before-acting note for memory_read.
 */
export function formatMemoryIndex(
  items: MemoryItem[],
  fullNewest: number = INDEX_FULL_NEWEST,
): string {
  if (items.length === 0) return "";
  const newest = new Set(
    [...items]
      .sort((a, b) => a.id - b.id)
      .slice(-fullNewest)
      .map((item) => item.id),
  );
  const lines = items.map((item) =>
    newest.has(item.id) ? `- [#${item.id}] ${item.content}` : indexLine(item),
  );
  return "Known memories (from earlier sessions):\n" + lines.join("\n") + `\n${INDEX_NOTE}`;
}

/**
 * The injected memories block. Full mode while it's affordable; automatically and
 * invisibly flips to index mode when the full rendering exceeds the threshold. Evaluated
 * once per engine build — a session is always in exactly one mode for its whole life.
 */
export function renderMemoryBlock(
  items: MemoryItem[],
  thresholdChars: number = INDEX_THRESHOLD_CHARS,
): string {
  const full = formatMemories(items);
  if (full.length <= thresholdChars) return full;
  return formatMemoryIndex(items);
}

// ---------------------------------------------------------------------------------------
// Episodic rendering — a separate block from the semantic one above. "What happened in
// past sessions here" is a different kind of context than "what's known to be true," and
// keeping them as distinct headings makes that legible to a reader of the prompt, not just
// to the code (see episodicStore.ts's module doc for the write/retrieval/decay policy).
// ---------------------------------------------------------------------------------------

/** Structurally identical to memory/episodicStore.ts's EpisodicItem — redeclared here so
 * this file (types + rendering only) doesn't need to import the SQLite adapter module. */
export interface EpisodicItemLike {
  summary: string;
  createdAt: string;
}

export function renderEpisodicBlock(items: EpisodicItemLike[]): string {
  if (items.length === 0) return "";
  const lines = items.map((item) => `- (${item.createdAt.slice(0, 10)}) ${item.summary}`);
  return "Recent sessions in this workspace (most recent first):\n" + lines.join("\n");
}
