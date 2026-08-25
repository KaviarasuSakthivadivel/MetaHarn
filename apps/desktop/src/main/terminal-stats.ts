import { getAdapter } from "./agents/registry.js";
import type { AgentKind, TerminalSessionStats } from "./agents/types.js";

export type { TerminalSessionStats } from "./agents/types.js";

/**
 * Dispatches to the right agent adapter's own transcript parser (see
 * agents/*.ts's getStats). There's no live API to ask any of these CLI
 * subprocesses for this — every adapter reads its own on-disk transcript
 * file directly. `externalId === null` means nothing's been recorded (or,
 * for Codex, not yet discovered) — same "No stats yet" empty state either
 * way, so this returns null rather than special-casing why.
 */
export function getTerminalSessionStats(
  cwd: string,
  agentKind: AgentKind,
  externalId: string | null,
): TerminalSessionStats | null {
  if (!externalId) return null;
  return getAdapter(agentKind).getStats(cwd, externalId);
}
