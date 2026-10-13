import type { AgentKind, SessionListItem } from "../preload/preload.js";

// The one shared source of truth for agent display names — matches
// agents/*.ts's real AgentAdapter.displayName in the main process exactly.
// TerminalTabStrip and AgentSwapMenu each used to hardcode their own
// independent label table (one capitalized sans-serif, one lowercase
// monospace) — two adjacent, simultaneously-visible controls describing
// the same live agent disagreed on its name/casing. Import this instead of
// adding another one.
/** A dropped file's real path (from webUtils.getPathForFile, via window.metaharn.getPathForFile)
 * wrapped in single quotes whenever it holds a character a shell or the chat composer would
 * otherwise split on — spaces are the common case, but this also covers the rest of what a real
 * macOS filename can legally contain. A bare single quote in the path is escaped the POSIX way
 * ('"'"'), which is correct shell-quoting even though the chat composer isn't itself a shell —
 * matching what a user would type by hand keeps paths usable if they go on to run a command with
 * one. Shared by the chat composer's and the terminal panes' onDrop handlers (App.tsx,
 * TerminalPane.tsx) so a dropped file's path reads the same wherever it lands. */
export function quotePathIfNeeded(path: string): string {
  if (/^[A-Za-z0-9/_.=:@-]+$/.test(path)) return path;
  return `'${path.replace(/'/g, `'"'"'`)}'`;
}

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

/** The last path segment of a cwd, natural case — the display name for a project/worktree that
 * has no registered name of its own (an unregistered/orphan project, a worktree checkout, a
 * dependency target). Previously force-uppercased, which read fine as a one-word badge but
 * turned into a shouting wall of caps for anything longer (an unregistered project literally
 * named "metaharn-owned-engine" rendered as "METAHARN-OWNED-ENGINE" in the sidebar) — every
 * caller that actually wants the small-caps *look* (an Eyebrow-style section label) already
 * applies its own CSS text-transform/.toUpperCase() at render time, so nothing relied on this
 * function doing it at the data layer. */
export function projectLabel(cwd: string): string {
  return cwd.split("/").filter(Boolean).pop() ?? "unknown";
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
