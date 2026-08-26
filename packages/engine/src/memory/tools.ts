/**
 * Memory tools — the agent's explicit paths into memory. Ported from OpenWorker's
 * coworker/memory/tools.py.
 *
 * `remember` saves a new fact; `memory_update` / `memory_forget` revise or retire one by
 * the [#id] shown in the known-memories block (memory/types.ts's renderMemoryBlock), so
 * corrections replace stale facts instead of piling up next to them. `memory_read`
 * fetches full bodies by id — the retrieval half of index mode; registered always,
 * harmless in full mode.
 *
 * `onSaved` is the save-notice hook: the caller passes a callback that can push a
 * memory_saved event to the session's surface so it can render "I'll remember that — …
 * [Undo]" inline in the transcript. It fires for memory_update too — the
 * update-don't-duplicate rule means many saves arrive as edits to an existing memory
 * rather than a new one, and those were invisible without this — carrying the previous
 * text so Undo can put it back. Failures in the callback never fail the write.
 */
import type { ToolDefinition, ToolMetadata } from "../types.js";
import type { MemoryItem, MemoryStore, Scope } from "./types.js";

const META: ToolMetadata = { category: "memory", riskLevel: "low", capabilities: ["remember"] };

const OFF_ERROR =
  "Saving memories is turned off in the user's Settings (they can turn it back on in " +
  "Settings ▸ Memory). Nothing was saved — tell the user plainly instead of implying " +
  "you remembered it.";

// All three of the Python source's enum values, so an out-of-date model/prompt still
// asking for the dead "session" scope is recognized (and rejected) rather than treated
// as just another unrecognized string — both paths land on "workspace" either way.
const KNOWN_SCOPE_STRINGS = new Set(["global", "workspace", "session"]);

export interface MemoryToolsOptions {
  store: MemoryStore;
  /** Attributes new workspace-scoped saves to this project; omit for a global-only setup. */
  workspace?: string;
  /** Save-notice hook (see module docstring). Best-effort — a throw here never fails the write. */
  onSaved?: (item: MemoryItem, previous: string | null) => void;
  /**
   * LIVE check, re-read on EVERY write call — never captured once at construction. The
   * registry is built once per engine, but the Settings switch must apply to
   * conversations already running, in both directions: memoizing a snapshot at build
   * time reproduces a real bug where flipping the switch off mid-session kept saving,
   * and flipping it back on kept refusing.
   */
  savingEnabled?: () => boolean;
}

function savingOff(savingEnabled?: () => boolean): boolean {
  return savingEnabled !== undefined && !savingEnabled();
}

function announce(
  onSaved: MemoryToolsOptions["onSaved"],
  item: MemoryItem,
  previous: string | null,
): void {
  if (!onSaved) return;
  try {
    onSaved(item, previous);
  } catch {
    // best-effort — the notice is never worth failing a write that already succeeded
  }
}

function resolveScope(raw: unknown): Scope {
  const candidate = typeof raw === "string" && KNOWN_SCOPE_STRINGS.has(raw) ? raw : "workspace";
  // "session" is a real string a caller can still send, but it's not part of this port's
  // Scope type (see memory/types.ts) — fall back to "workspace" exactly like the Python
  // did, instead of ever producing a scope this engine can't otherwise reach.
  return candidate === "session" ? "workspace" : (candidate as Scope);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function requireInt(value: unknown, label: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`${label} must be a number, got ${JSON.stringify(value)}`);
  }
  return Math.trunc(n);
}

/** The agent's memory tools: remember, memory_read, memory_update, memory_forget. */
export function memoryTools(opts: MemoryToolsOptions): ToolDefinition[] {
  const { store, workspace, onSaved, savingEnabled } = opts;

  const remember: ToolDefinition = {
    name: "remember",
    schema: {
      type: "function",
      function: {
        name: "remember",
        description:
          "Save a durable memory (a fact or preference) to recall in future sessions. " +
          "Check the known-memories list first: if one already covers this, use " +
          "memory_update instead of saving a near-duplicate.",
        parameters: {
          type: "object",
          properties: {
            content: { type: "string", description: "The thing to remember, with the why." },
            summary: {
              type: "string",
              description: "One-line gist (15 words max) shown in compact listings.",
            },
            scope: {
              type: "string",
              enum: ["global", "workspace"],
              description:
                '"global" (facts about the user — applies everywhere) or "workspace" ' +
                "(facts about this project only).",
            },
          },
          required: ["content"],
          additionalProperties: false,
        },
      },
    },
    metadata: { ...META, risk: "write_local" },
    execute: async (args: Record<string, unknown>): Promise<unknown> => {
      if (savingOff(savingEnabled)) return { saved: false, error: OFF_ERROR };
      const scope = resolveScope(args.scope);
      const summary = asString(args.summary).trim();
      const item = store.add(asString(args.content), {
        scope,
        summary: summary || undefined,
        workspace: scope === "workspace" ? workspace : undefined,
      });
      announce(onSaved, item, null);
      return { id: item.id, scope: item.scope, saved: true };
    },
  };

  const memoryRead: ToolDefinition = {
    name: "memory_read",
    schema: {
      type: "function",
      function: {
        name: "memory_read",
        description:
          "Read the full content of memories by id (use when the known-memories list " +
          "shows only a one-line summary and you need the details before acting).",
        parameters: {
          type: "object",
          properties: {
            memory_ids: {
              type: "array",
              items: { type: "integer" },
              description: "The [#id]s to fetch.",
            },
          },
          required: ["memory_ids"],
          additionalProperties: false,
        },
      },
    },
    metadata: { ...META, risk: "read" },
    // Never gated by savingEnabled: off means "stop learning new things", not amnesia
    // about what's already saved.
    execute: async (args: Record<string, unknown>): Promise<unknown> => {
      const rawIds = Array.isArray(args.memory_ids) ? args.memory_ids : [];
      const found: Array<{ id: number; scope: Scope; content: string }> = [];
      const missing: number[] = [];
      for (const raw of rawIds) {
        const id = requireInt(raw, "memory_ids[]");
        const item = store.get(id);
        if (item) found.push({ id: item.id, scope: item.scope, content: item.content });
        else missing.push(id);
      }
      const result: { memories: typeof found; missing?: number[] } = { memories: found };
      if (missing.length > 0) result.missing = missing;
      return result;
    },
  };

  const memoryUpdate: ToolDefinition = {
    name: "memory_update",
    schema: {
      type: "function",
      function: {
        name: "memory_update",
        description: "Rewrite an existing memory with corrected or refined content.",
        parameters: {
          type: "object",
          properties: {
            memory_id: {
              type: "integer",
              description: "The memory's id, from the [#id] in the known-memories list.",
            },
            content: {
              type: "string",
              description: "The full corrected memory text (replaces the old text).",
            },
            summary: { type: "string", description: "Corrected one-line gist (15 words max)." },
          },
          required: ["memory_id", "content"],
          additionalProperties: false,
        },
      },
    },
    metadata: { ...META, risk: "write_local" },
    execute: async (args: Record<string, unknown>): Promise<unknown> => {
      if (savingOff(savingEnabled)) return { updated: false, error: OFF_ERROR };
      const id = requireInt(args.memory_id, "memory_id");
      // Captured BEFORE the write so the caller's Undo can restore the old wording.
      const existing = store.get(id);
      const previous = existing ? existing.content : null;
      const summary = asString(args.summary).trim();
      const item = store.update(id, asString(args.content), { summary: summary || undefined });
      if (!item) return { updated: false, error: `no memory with id ${id}` };
      announce(onSaved, item, previous);
      return { updated: true, id: item.id };
    },
  };

  const memoryForget: ToolDefinition = {
    name: "memory_forget",
    schema: {
      type: "function",
      function: {
        name: "memory_forget",
        description: "Delete a memory that turned out to be wrong or is no longer true.",
        parameters: {
          type: "object",
          properties: {
            memory_id: {
              type: "integer",
              description: "The memory's id, from the [#id] in the known-memories list.",
            },
          },
          required: ["memory_id"],
          additionalProperties: false,
        },
      },
    },
    metadata: { ...META, risk: "write_local" },
    execute: async (args: Record<string, unknown>): Promise<unknown> => {
      if (savingOff(savingEnabled)) return { deleted: false, error: OFF_ERROR };
      const id = requireInt(args.memory_id, "memory_id");
      if (store.delete(id)) return { deleted: true, id };
      return { deleted: false, error: `no memory with id ${id}` };
    },
  };

  return [remember, memoryRead, memoryUpdate, memoryForget];
}
