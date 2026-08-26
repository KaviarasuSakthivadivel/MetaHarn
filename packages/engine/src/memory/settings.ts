/**
 * Memory settings — the on/off switch and the user's standing rules. Ported from
 * OpenWorker's coworker/memory/settings.py.
 *
 * Settings-level state, deliberately outside the memory table (MEMORY-SPEC §2, §4.3, §6):
 *
 * - `enabled`: off means engines are built with no memory tools, no memories block, and
 *   no memory guidance. Existing memories are kept but inert. Read at build time; running
 *   sessions finish under the mode they started with. tools.ts's live `savingEnabled`
 *   check exists precisely so a Settings flip mid-session still takes effect on writes,
 *   even though the tool *registration* itself only reacts on the next build.
 * - `userRules`: one text blob the user typed into Settings. Injected verbatim above auto
 *   memories (via formatUserRules below); on conflict the rule wins. The agent never
 *   writes, edits, or deletes this — no tool in tools.ts touches it; the only writer is a
 *   future Settings UI calling `.set()` directly.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * User Rules is a bounded settings field, not a document store: big enough for any real
 * rule list, small enough that a paste-accident (or a hostile client) can't bloat every
 * future system prompt.
 */
export const MAX_USER_RULES_CHARS = 20_000;

interface MemorySettingsData {
  enabled?: boolean;
  userRules?: string;
}

export interface MemorySettingsSnapshot {
  enabled: boolean;
  userRules: string;
}

export interface MemorySettingsUpdate {
  enabled?: boolean;
  userRules?: string;
}

export class MemorySettingsStore {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  private load(): MemorySettingsData {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf-8"));
      return parsed !== null && typeof parsed === "object" ? (parsed as MemorySettingsData) : {};
    } catch {
      // Missing file, unreadable file, or invalid JSON: same fallback as never having
      // been configured — everything below already has sane defaults for an empty object.
      return {};
    }
  }

  private save(data: MemorySettingsData): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(data, null, 2), "utf-8");
  }

  get enabled(): boolean {
    const value = this.load().enabled;
    return value === undefined ? true : Boolean(value); // on by default (spec §5.4)
  }

  get userRules(): string {
    const value = this.load().userRules;
    return typeof value === "string" ? value : "";
  }

  set(update: MemorySettingsUpdate): MemorySettingsSnapshot {
    const data = this.load();
    if (update.enabled !== undefined) data.enabled = Boolean(update.enabled);
    if (update.userRules !== undefined) {
      data.userRules = String(update.userRules).slice(0, MAX_USER_RULES_CHARS);
    }
    this.save(data);
    return this.snapshot();
  }

  snapshot(): MemorySettingsSnapshot {
    return { enabled: this.enabled, userRules: this.userRules };
  }
}

/** The system-prompt block for user rules. Empty rules -> empty string. */
export function formatUserRules(rules: string): string {
  const text = (rules ?? "").trim();
  if (!text) return "";
  return (
    "User rules (written by the user in Settings; always follow these — on any " +
    `conflict they outrank learned memories):\n${text}`
  );
}
