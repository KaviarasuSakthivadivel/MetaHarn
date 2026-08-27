/** Settings > Memory for the owned-engine backend — Electron's mirror of
 * apps/server/src/memoryApi.ts, pointed at the SAME memory.db ownedEngine.ts's sessions read
 * (app.getPath("userData")/memory.db), so edits here are visible to the next session. */
import { join } from "node:path";
import { app } from "electron";
import { SqliteMemoryStore } from "@metaharn/engine/src/memory/sqliteStore.js";
import type { MemoryItem, Scope } from "@metaharn/engine/src/memory/types.js";

let memoryStore: SqliteMemoryStore | undefined;
function store(): SqliteMemoryStore {
  if (!memoryStore) memoryStore = new SqliteMemoryStore(join(app.getPath("userData"), "memory.db"));
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

export function deleteMemory(id: number): boolean {
  return store().delete(id);
}
