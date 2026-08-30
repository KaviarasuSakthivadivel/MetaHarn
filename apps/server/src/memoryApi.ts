/** Settings > Memory: browse/add/delete the same durable memories the agent's own
 * `remember`/`memory_update`/`memory_forget` tools read and write (memory.db), so a user can
 * manage them directly instead of only through conversation. Also the read/manage surface for
 * the other two memory tiers session.ts writes to — episodic (auto-derived session summaries)
 * and procedural (durable standing permission rules) — and the settings that gate all of it. */
import { SqliteMemoryStore } from "@metaharn/engine/src/memory/sqliteStore.js";
import { SqliteEpisodicStore, type EpisodicItem } from "@metaharn/engine/src/memory/episodicStore.js";
import { SqliteProceduralStore, type ProceduralRule } from "@metaharn/engine/src/memory/proceduralStore.js";
import { MemorySettingsStore, type MemorySettingsSnapshot, type MemorySettingsUpdate } from "@metaharn/engine/src/memory/settings.js";
import type { MemoryItem, Scope } from "@metaharn/engine/src/memory/types.js";
import { statePath } from "./state.js";

let memoryStore: SqliteMemoryStore | undefined;
function store(): SqliteMemoryStore {
  if (!memoryStore) memoryStore = new SqliteMemoryStore(statePath("memory.db"));
  return memoryStore;
}

let episodicStore: SqliteEpisodicStore | undefined;
function episodic(): SqliteEpisodicStore {
  if (!episodicStore) episodicStore = new SqliteEpisodicStore(statePath("episodicMemory.db"));
  return episodicStore;
}

let proceduralStore: SqliteProceduralStore | undefined;
function procedural(): SqliteProceduralStore {
  if (!proceduralStore) proceduralStore = new SqliteProceduralStore(statePath("proceduralMemory.db"));
  return proceduralStore;
}

let memorySettingsStore: MemorySettingsStore | undefined;
function memorySettings(): MemorySettingsStore {
  if (!memorySettingsStore) memorySettingsStore = new MemorySettingsStore(statePath("memorySettings.json"));
  return memorySettingsStore;
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

// -- episodic (auto-derived session summaries) ---------------------------------------------

export function listEpisodicMemories(workspace: string, limit = 20): EpisodicItem[] {
  return episodic().listRecent(workspace, limit);
}

// -- procedural (durable standing permission rules) ----------------------------------------

/** All rules for a workspace, promoted or not — a not-yet-promoted grant (observed in fewer
 * than the promotion threshold's worth of distinct sessions) is still shown, so a user can see
 * a pattern forming rather than have it appear only once it's already silently in effect. */
export function listProceduralRules(workspace: string): ProceduralRule[] {
  return procedural().listAll("workspace", workspace);
}

export function revokeProceduralRule(id: number): boolean {
  return procedural().revoke(id);
}

// -- memory settings (the enabled toggle + user rules) --------------------------------------

export function getMemorySettings(): MemorySettingsSnapshot {
  return memorySettings().snapshot();
}

export function setMemorySettings(update: MemorySettingsUpdate): MemorySettingsSnapshot {
  return memorySettings().set(update);
}

/** Recency-bounded decay for the two auto-derived tiers (see episodicStore.ts's and
 * proceduralStore.ts's own module docs for why this, not contradiction detection, is the
 * honest policy). Called once at server boot (index.ts) — a lazy, once-per-process sweep is
 * enough for a locally-run single-user tool; no cron needed. */
export function pruneStaleMemory(): void {
  try {
    episodic().pruneOlderThan(180);
  } catch (err) {
    console.warn("[metaharn-server] episodic memory prune failed:", (err as Error).message);
  }
  try {
    procedural().pruneStale(90);
  } catch (err) {
    console.warn("[metaharn-server] procedural memory prune failed:", (err as Error).message);
  }
}
