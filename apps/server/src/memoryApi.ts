/** Settings > Memory: browse/add/delete the same durable memories the agent's own
 * `remember`/`memory_update`/`memory_forget` tools read and write (memory.db), so a user can
 * manage them directly instead of only through conversation. */
import { SqliteMemoryStore } from "@metaharn/engine/src/memory/sqliteStore.js";
import type { MemoryItem, Scope } from "@metaharn/engine/src/memory/types.js";
import { statePath } from "./state.js";

let memoryStore: SqliteMemoryStore | undefined;
function store(): SqliteMemoryStore {
  if (!memoryStore) memoryStore = new SqliteMemoryStore(statePath("memory.db"));
  return memoryStore;
}

export function listMemories(filter: { scope?: Scope; workspace?: string } = {}): MemoryItem[] {
  return store()
    .list(filter)
    .sort((a, b) => b.id - a.id);
}

export function addMemory(content: string, opts: { scope?: Scope; workspace?: string; summary?: string } = {}): MemoryItem {
  return store().add(content, opts);
}

export function updateMemory(id: number, content: string, summary?: string): MemoryItem | undefined {
  return store().update(id, content, { summary });
}

export function deleteMemory(id: number): boolean {
  return store().delete(id);
}
