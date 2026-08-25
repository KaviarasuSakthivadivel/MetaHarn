import { execSync } from "node:child_process";
import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import { geminiAdapter } from "./gemini.js";
import { opencodeAdapter } from "./opencode.js";
import type { AgentAdapter, AgentKind } from "./types.js";

export const AGENT_ADAPTERS: Record<AgentKind, AgentAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  gemini: geminiAdapter,
  opencode: opencodeAdapter,
};

export function getAdapter(kind: AgentKind): AgentAdapter {
  return AGENT_ADAPTERS[kind];
}

/**
 * The single place that answers "what CLI id should I pass to resume this
 * session" — Claude can be told its id upfront (canForceSessionId), so
 * MetaHarn's own catalog row id doubles as Claude's session id whether or not
 * `externalSessionId` was ever explicitly populated in the DB. This is what
 * lets pre-migration Claude rows (externalSessionId always null, since the
 * column didn't exist yet) resolve correctly with no backfill script.
 */
export function resolveExternalSessionId(session: {
  agentKind: AgentKind;
  id: string;
  externalSessionId: string | null;
}): string | null {
  if (session.externalSessionId) return session.externalSessionId;
  return getAdapter(session.agentKind).canForceSessionId ? session.id : null;
}

function isOnPath(binary: string): boolean {
  try {
    const command = process.platform === "win32" ? `where ${binary}` : `which ${binary}`;
    return execSync(command, { encoding: "utf-8" }).trim().length > 0;
  } catch {
    return false; // non-zero exit = not installed, expected for most machines/most agents
  }
}

// Memoized for the process lifetime — PATH doesn't change mid-run, and this
// shouldn't spawn a shell every time the "+ New terminal session" button
// renders. Same which-based detection pattern ipc.ts's
// resolveSystemNodePath() already uses.
let cachedInstalled: AgentKind[] | undefined;

export function detectInstalledAgents(): AgentKind[] {
  if (cachedInstalled) return cachedInstalled;
  cachedInstalled = (Object.values(AGENT_ADAPTERS) as AgentAdapter[]).filter((a) => isOnPath(a.binary)).map((a) => a.kind);
  return cachedInstalled;
}

/** Called after install/uninstall (see agents/lifecycle.ts) — PATH-visible
 * binaries just changed, so the memoized detection above would otherwise
 * keep reporting stale results for the rest of the app's lifetime. */
export function invalidateInstalledCache() {
  cachedInstalled = undefined;
}
