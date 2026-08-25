import type { AgentKind, SessionListItem } from "../preload/preload.js";

// The one shared source of truth for agent display names — matches
// agents/*.ts's real AgentAdapter.displayName in the main process exactly.
// TerminalTabStrip and AgentSwapMenu each used to hardcode their own
// independent label table (one capitalized sans-serif, one lowercase
// monospace) — two adjacent, simultaneously-visible controls describing
// the same live agent disagreed on its name/casing. Import this instead of
// adding another one.
export const ALL_AGENT_KINDS: AgentKind[] = ["claude", "codex", "gemini", "opencode"];
export const AGENT_DISPLAY_NAMES: Record<AgentKind, string> = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini",
  opencode: "OpenCode",
};

/** Per-project session count + most recent session activity, derived from
 * the full session list — shared by ProjectsListPage.tsx (sorting) and
 * Sidebar.tsx (choosing which projects to surface), rather than each
 * re-deriving the same reduce independently. */
export function computeProjectStats(sessions: SessionListItem[]): Map<string, { count: number; lastActivity?: Date }> {
  const stats = new Map<string, { count: number; lastActivity?: Date }>();
  for (const session of sessions) {
    const entry = stats.get(session.cwd) ?? { count: 0 };
    entry.count += 1;
    if (!entry.lastActivity || session.modified.getTime() > entry.lastActivity.getTime()) {
      entry.lastActivity = session.modified;
    }
    stats.set(session.cwd, entry);
  }
  return stats;
}

export function projectLabel(cwd: string): string {
  return (
    cwd
      .split("/")
      .filter(Boolean)
      .pop()
      ?.toUpperCase() ?? "UNKNOWN"
  );
}

export function sessionTitle(session: SessionListItem): string {
  if (session.type === "terminal") return session.name ?? "Terminal session";
  if (session.name) return session.name;
  const first = session.firstMessage.trim().replace(/\s+/g, " ");
  return first.length > 60 ? `${first.slice(0, 60)}...` : first || "(empty session)";
}

export function formatRelativeTime(date: Date): string {
  const seconds = Math.max(0, (Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.floor(minutes)}m ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)}h ago`;
  const days = hours / 24;
  if (days < 30) return `${Math.floor(days)}d ago`;
  return date.toLocaleDateString();
}

/** Compact "age" for a badge (e.g. "7d") rather than prose ("7d ago"). */
export function formatAge(date: Date): string {
  const seconds = Math.max(0, (Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "now";
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.floor(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)}h`;
  const days = hours / 24;
  if (days < 365) return `${Math.floor(days)}d`;
  return `${Math.floor(days / 365)}y`;
}
