import { useState } from "react";
import type { SessionDependency, ProjectListItem, SessionListItem, WorktreeLink } from "../preload/preload.js";
import { AGENT_DISPLAY_NAMES, computeProjectStats, formatRelativeTime, projectLabel, sessionTitle } from "./format.js";
import { Eyebrow, RADIUS, SPACE, TEXT } from "./ui.js";
import { ArchiveIcon, ClockIcon, ForkIcon, GripIcon, LinkIcon, MapIcon, PlusIcon, WorktreeIcon } from "./icons.js";
import DependencyMenu from "./DependencyMenu.js";
import MinimapPanel from "./MinimapPanel.js";

export type SessionStatus = "working" | "waiting" | "active" | "idle" | "exited";

interface SidebarProps {
  projects: ProjectListItem[];
  sessions: SessionListItem[];
  activeCwd?: string;
  activeSessionPath?: string;
  /** Keyed by session.path — only sessions with a real, live signal have an
   * entry (see App.tsx's doc comment on how this is derived). */
  sessionStatuses: Map<string, SessionStatus>;
  dependencies: SessionDependency[];
  /** Real `git worktree` checkouts, linked to the project they were created
   * from (see packages/db/src/schema.ts's projectWorktrees doc comment) —
   * their sessions render merged into the parent's card list instead of as
   * their own project. */
  worktreeLinks: WorktreeLink[];
  onSelectProject: (cwd: string) => void;
  onOpenTerminal: (cwd: string) => void;
  onShowAllProjects: () => void;
  onSelectSession: (session: SessionListItem) => void;
  /** Reversible — hides the session from the normal list without touching
   * its real file/pty (see catalog.ts's archiveSession doc comment).
   * Permanent deletion isn't reachable from this card anymore; it lives in
   * ProjectOverview.tsx's "ARCHIVED SESSIONS" section instead. */
  onArchiveSession: (session: SessionListItem) => void;
  onForkSession: (session: SessionListItem) => void;
  onCreateWorktreeSession: (session: SessionListItem) => void;
  onSetDependency: (session: SessionListItem, dependsOn: SessionListItem) => void;
  onRemoveDependency: (dep: SessionDependency) => void;
}

const MAX_GROUPS = 8;

/**
 * One persistent sidebar: sessions grouped directly under their project, no
 * separate "Projects" list above a separate "Sessions" list — a
 * fleet-view-style sidebar (project name as a collapsible group header,
 * sessions inside as real elevated cards), which turned out to be
 * a materially better fit than this file's earlier two-stacked-sections
 * layout: a project *is* the thing sessions belong to, not a separate
 * navigation surface competing with them for space.
 *
 * Scoping ("this project" vs "all projects") controls how many groups
 * render — one (the active project) vs up to MAX_GROUPS, most-recent
 * first — rather than which of two sections is expanded, since there's
 * only one kind of section now.
 */
export default function Sidebar({
  projects,
  sessions,
  activeCwd,
  activeSessionPath,
  sessionStatuses,
  dependencies,
  worktreeLinks,
  onSelectProject,
  onOpenTerminal,
  onShowAllProjects,
  onSelectSession,
  onArchiveSession,
  onForkSession,
  onCreateWorktreeSession,
  onSetDependency,
  onRemoveDependency,
}: SidebarProps) {
  const [showAllProjects, setShowAllProjects] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [dependencyMenuFor, setDependencyMenuFor] = useState<{ session: SessionListItem; anchorRect: DOMRect } | null>(null);
  const [minimapAnchor, setMinimapAnchor] = useState<DOMRect | null>(null);

  // No project to scope to (e.g. the projects-list landing page) means
  // there's nothing meaningful "just this project" could mean — auto-expand
  // to every group rather than showing nothing.
  const effectiveShowAll = showAllProjects || !activeCwd;

  // A worktree checkout's sessions render under its PARENT's group, not
  // their own — effectiveCwd() is the one place that resolution happens;
  // everything below groups by this, never by session.cwd directly.
  const worktreeParentByCwd = new Map(worktreeLinks.map((l) => [l.cwd, l.parentCwd]));
  const effectiveCwd = (cwd: string) => worktreeParentByCwd.get(cwd) ?? cwd;

  const projectStats = computeProjectStats(sessions);
  const sortedProjects = [...projects].sort((a, b) => {
    const aActive = a.localPath === activeCwd ? 1 : 0;
    const bActive = b.localPath === activeCwd ? 1 : 0;
    if (aActive !== bActive) return bActive - aActive;
    const aTime = projectStats.get(a.localPath)?.lastActivity?.getTime() ?? 0;
    const bTime = projectStats.get(b.localPath)?.lastActivity?.getTime() ?? 0;
    if (aTime !== bTime) return bTime - aTime;
    return a.name.localeCompare(b.name);
  });

  const groupProjects = effectiveShowAll
    ? sortedProjects.slice(0, MAX_GROUPS)
    : sortedProjects.filter((p) => p.localPath === activeCwd);
  // A session whose project got un-registered (removed) but whose row
  // still exists shouldn't just vanish — synthesize a minimal group for it
  // the same way the old GroupedSessionList already did (projectLabel(cwd)
  // as a display-name fallback with no click-to-Overview capability).
  // Checked against the FULL `projects` list, not just the capped
  // `groupProjects` — a registered project sitting just outside MAX_GROUPS
  // is "not shown right now," not "unregistered."
  // A worktree's own cwd is deliberately absent from `projects` (see
  // listProjects, ipc.ts) but it's linked, not unregistered — excluded here
  // so it doesn't ALSO get a spurious orphan group alongside showing up
  // correctly merged into its parent's.
  const registeredCwds = new Set(projects.map((p) => p.localPath));
  const orphanCwds = effectiveShowAll
    ? [...new Set(sessions.map((s) => s.cwd))].filter((cwd) => !registeredCwds.has(cwd) && !worktreeParentByCwd.has(cwd))
    : activeCwd && !registeredCwds.has(activeCwd) && !worktreeParentByCwd.has(activeCwd)
      ? [activeCwd]
      : [];

  const canFork = (session: SessionListItem) => session.type === "terminal" || session.path === activeSessionPath;
  const openDependencyMenu = (session: SessionListItem, anchorRect: DOMRect) => setDependencyMenuFor({ session, anchorRect });
  const toggleGroup = (cwd: string) =>
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(cwd)) next.delete(cwd);
      else next.add(cwd);
      return next;
    });

  const sharedGroupProps = {
    activeCwd,
    activeSessionPath,
    sessionStatuses,
    worktreeParentByCwd,
    collapsedGroups,
    onToggleGroup: toggleGroup,
    onSelectProject,
    onOpenTerminal,
    onSelectSession,
    onArchiveSession,
    onForkSession,
    canFork,
    onCreateWorktreeSession,
    onOpenDependencyMenu: openDependencyMenu,
  };

  const hasAnyGroups = groupProjects.length > 0 || orphanCwds.length > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: `${SPACE.sm}px ${SPACE.md}px`,
          borderBottom: "1px solid var(--color-border)",
          flexShrink: 0,
        }}
      >
        <Eyebrow>Sessions</Eyebrow>
        <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
          <button
            onClick={(e) => setMinimapAnchor(e.currentTarget.getBoundingClientRect())}
            aria-label="Session dependency minimap"
            className="metaharn-icon-btn metaharn-tooltip"
            style={{
              display: "flex",
              border: "none",
              background: "transparent",
              color: "var(--color-text-muted)",
              cursor: "pointer",
              padding: 4,
              borderRadius: RADIUS.sm,
            }}
          >
            <MapIcon size={13} />
          </button>
          {activeCwd && (
            <button
              onClick={() => setShowAllProjects((v) => !v)}
              title={effectiveShowAll ? "Show only this project's sessions" : "Show sessions from every project"}
              style={{
                border: "none",
                background: "transparent",
                color: "var(--color-text-muted)",
                cursor: "pointer",
                fontSize: TEXT.xs,
                padding: "2px 4px",
              }}
            >
              {effectiveShowAll ? "all projects" : "this project"}
            </button>
          )}
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: `${SPACE.sm}px 0` }}>
        {!hasAnyGroups && (
          <p style={{ padding: `0 ${SPACE.md}px`, color: "var(--color-text-muted)", fontSize: TEXT.base }}>
            {projects.length === 0 ? "No projects yet." : "No sessions yet."}
          </p>
        )}
        {groupProjects.map((project) => (
          <ProjectGroup
            key={project.id}
            cwd={project.localPath}
            name={project.name}
            sessions={sessions.filter((s) => effectiveCwd(s.cwd) === project.localPath)}
            {...sharedGroupProps}
          />
        ))}
        {orphanCwds.map((cwd) => (
          <ProjectGroup
            key={cwd}
            cwd={cwd}
            name={projectLabel(cwd)}
            sessions={sessions.filter((s) => s.cwd === cwd)}
            unregistered
            {...sharedGroupProps}
          />
        ))}
        {projects.length > 0 && (
          <button
            onClick={onShowAllProjects}
            style={{
              display: "block",
              width: "100%",
              textAlign: "left",
              padding: `${SPACE.xs + 2}px ${SPACE.md}px`,
              marginTop: SPACE.xs,
              border: "none",
              background: "transparent",
              color: "var(--color-text-muted)",
              cursor: "pointer",
              fontSize: TEXT.sm,
            }}
          >
            Browse all projects →
          </button>
        )}
      </div>

      {dependencyMenuFor && (
        <DependencyMenu
          candidates={sessions.filter((s) => s.path !== dependencyMenuFor.session.path)}
          anchorRect={dependencyMenuFor.anchorRect}
          onPick={(target) => {
            onSetDependency(dependencyMenuFor.session, target);
            setDependencyMenuFor(null);
          }}
          onClose={() => setDependencyMenuFor(null)}
        />
      )}
      {minimapAnchor && (
        <MinimapPanel
          sessions={sessions}
          dependencies={dependencies}
          anchorRect={minimapAnchor}
          onRemove={onRemoveDependency}
          onClose={() => setMinimapAnchor(null)}
        />
      )}
    </div>
  );
}

const SESSION_ORDER_KEY_PREFIX = "metaharn:sessionOrder:";

/**
 * Manual per-project session ordering, set by dragging cards in the
 * sidebar (see SessionCard's drag handle below). Local-machine-only via
 * localStorage — matching this app's own existing precedent for UI-
 * preference state (App.tsx's sidebar-width key) — not a DB-synced concept
 * like archiving or dependencies, since this is a personal display
 * preference with no reason to round-trip through the main process.
 *
 * A session not present in a saved order (created, or un-archived, after
 * the user last dragged something) is "not yet placed": it sorts ahead of
 * the manually-ordered ones, in the app's normal most-recent-first order,
 * so a brand-new session shows up at the top instead of silently sinking
 * below a stale manual arrangement. No saved order at all (the common
 * case, and every project before this feature existed) means zero
 * behavior change — pure recency sort, same as always.
 */
function readSessionOrder(cwd: string): string[] | null {
  try {
    const raw = localStorage.getItem(SESSION_ORDER_KEY_PREFIX + cwd);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : null;
  } catch {
    return null;
  }
}

function writeSessionOrder(cwd: string, order: string[]) {
  try {
    localStorage.setItem(SESSION_ORDER_KEY_PREFIX + cwd, JSON.stringify(order));
  } catch {
    // Storage full/unavailable (private mode, quota) — the reorder just
    // won't survive a reload. Not worth surfacing as an error for what's
    // ultimately a cosmetic preference, not real data.
  }
}

function applySessionOrder(recencySorted: SessionListItem[], order: string[] | null): SessionListItem[] {
  if (!order || order.length === 0) return recencySorted;
  const byPath = new Map(recencySorted.map((s) => [s.path, s] as const));
  const placed = order.map((path) => byPath.get(path)).filter((s): s is SessionListItem => Boolean(s));
  const placedPaths = new Set(placed.map((s) => s.path));
  const unplaced = recencySorted.filter((s) => !placedPaths.has(s.path));
  return [...unplaced, ...placed];
}

function ProjectGroup({
  cwd,
  name,
  sessions,
  unregistered,
  activeCwd,
  activeSessionPath,
  sessionStatuses,
  worktreeParentByCwd,
  collapsedGroups,
  onToggleGroup,
  onSelectProject,
  onOpenTerminal,
  onSelectSession,
  onArchiveSession,
  onForkSession,
  canFork,
  onCreateWorktreeSession,
  onOpenDependencyMenu,
}: {
  cwd: string;
  name: string;
  sessions: SessionListItem[];
  unregistered?: boolean;
  activeCwd?: string;
  activeSessionPath?: string;
  sessionStatuses: Map<string, SessionStatus>;
  worktreeParentByCwd: Map<string, string>;
  collapsedGroups: Set<string>;
  onToggleGroup: (cwd: string) => void;
  onSelectProject: (cwd: string) => void;
  onOpenTerminal: (cwd: string) => void;
  onSelectSession: (session: SessionListItem) => void;
  onArchiveSession: (session: SessionListItem) => void;
  onForkSession: (session: SessionListItem) => void;
  canFork: (session: SessionListItem) => boolean;
  onCreateWorktreeSession: (session: SessionListItem) => void;
  onOpenDependencyMenu: (session: SessionListItem, anchorRect: DOMRect) => void;
}) {
  const collapsed = collapsedGroups.has(cwd);
  const active = cwd === activeCwd;
  const recencySorted = [...sessions].sort((a, b) => b.modified.getTime() - a.modified.getTime());
  // Lazy-initialized once per mount (a real cwd change always remounts this
  // component — Sidebar.tsx keys each ProjectGroup by project.id/cwd — so
  // there's no case where a stale order from a previous project lingers).
  const [manualOrder, setManualOrder] = useState<string[] | null>(() => readSessionOrder(cwd));
  const sorted = applySessionOrder(recencySorted, manualOrder);
  // Which session's drag handle is currently held down — local to THIS
  // group's own state, which is what actually confines a drag to its own
  // project: a drag started in a different ProjectGroup instance lives in
  // that instance's own separate state and is invisible here, so dropping
  // on a card in the wrong group is a silent, harmless no-op rather than
  // something that needs an explicit guard.
  const [draggedPath, setDraggedPath] = useState<string | null>(null);

  const reorder = (fromPath: string, toPath: string) => {
    if (fromPath === toPath) return;
    const next = [...sorted];
    const fromIdx = next.findIndex((s) => s.path === fromPath);
    const toIdx = next.findIndex((s) => s.path === toPath);
    if (fromIdx === -1 || toIdx === -1) return;
    // Swap, not insert-and-shift — same semantics as TerminalGrid.tsx's own
    // drag-reorder (reorderGrid in App.tsx), the one other place this app
    // already does this.
    [next[fromIdx], next[toIdx]] = [next[toIdx], next[fromIdx]];
    const nextOrder = next.map((s) => s.path);
    setManualOrder(nextOrder);
    writeSessionOrder(cwd, nextOrder);
  };

  return (
    <div style={{ marginBottom: SPACE.sm }}>
      <div style={{ display: "flex", alignItems: "center", gap: 2, padding: `2px ${SPACE.sm}px` }}>
        <button
          onClick={() => onToggleGroup(cwd)}
          aria-label={collapsed ? "Expand" : "Collapse"}
          className="metaharn-tooltip"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 18,
            flexShrink: 0,
            border: "none",
            background: "transparent",
            color: "var(--color-text-muted)",
            cursor: "pointer",
            fontSize: 10,
          }}
        >
          {collapsed ? "▸" : "▾"}
        </button>
        <button
          onClick={() => !unregistered && onSelectProject(cwd)}
          disabled={unregistered}
          style={{
            flex: 1,
            minWidth: 0,
            textAlign: "left",
            border: "none",
            background: "transparent",
            color: active ? "var(--color-accent)" : "var(--color-text-muted)",
            cursor: unregistered ? "default" : "pointer",
            padding: "3px 0",
            fontSize: TEXT.xs,
            fontWeight: 700,
            letterSpacing: 0.5,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {name.toUpperCase()}
        </button>
        {!unregistered && (
          <IconButton title="New session in this project" onClick={() => onOpenTerminal(cwd)}>
            <PlusIcon size={12} />
          </IconButton>
        )}
      </div>

      {!collapsed &&
        (sorted.length === 0 ? (
          <p style={{ padding: `2px ${SPACE.md}px ${SPACE.xs}px 26px`, color: "var(--color-text-muted)", fontSize: TEXT.sm }}>
            No sessions yet.
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: `${SPACE.xs}px ${SPACE.sm}px 0` }}>
            {sorted.map((session) => (
              <SessionCard
                key={session.path}
                session={session}
                active={session.path === activeSessionPath}
                status={sessionStatuses.get(session.path)}
                canFork={canFork(session)}
                isWorktree={worktreeParentByCwd.has(session.cwd)}
                isDragSource={draggedPath === session.path}
                onSelect={() => onSelectSession(session)}
                onArchive={() => onArchiveSession(session)}
                onFork={() => onForkSession(session)}
                onCreateWorktree={() => onCreateWorktreeSession(session)}
                onOpenDependencyMenu={(rect) => onOpenDependencyMenu(session, rect)}
                onDragHandleStart={() => setDraggedPath(session.path)}
                onDragHandleEnd={() => setDraggedPath(null)}
                onDropHere={() => {
                  if (draggedPath) reorder(draggedPath, session.path);
                  setDraggedPath(null);
                }}
              />
            ))}
          </div>
        ))}
    </div>
  );
}

export const STATUS_LABEL: Record<SessionStatus, string> = {
  working: "Working",
  waiting: "Waiting for input",
  active: "Active",
  idle: "Idle",
  exited: "Exited",
};

export function statusColor(status: SessionStatus): string {
  switch (status) {
    case "working":
    case "active":
      return "var(--color-status-working)";
    case "waiting":
      return "var(--color-status-waiting)";
    case "exited":
      return "var(--color-error)";
    default:
      return "var(--color-status-idle)";
  }
}

/** The status line: a breathing dot for genuinely live states (Working /
 * Active — motion carries meaning here, not decoration), a clock glyph for
 * Waiting, plain colored text for Idle/Exited. No status at all (session
 * not currently live — see App.tsx's sessionStatuses) falls back to a
 * plain relative-time line instead of guessing a state. */
export function StatusLine({ status, fallback }: { status?: SessionStatus; fallback: string }) {
  if (!status) {
    // Secondary, not muted — a relative-time fallback is still genuinely
    // useful glanceable info, not decoration, and muted was reading as
    // washed-out next to the bolder title above it.
    return <span style={{ color: "var(--color-text-secondary)" }}>{fallback}</span>;
  }
  const live = status === "working" || status === "active";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: statusColor(status) }}>
      {live && <span className="metaharn-status-pulse" style={{ width: 6, height: 6, borderRadius: "50%", background: "currentColor" }} />}
      {status === "waiting" && <ClockIcon size={10} />}
      {STATUS_LABEL[status]}
    </span>
  );
}

function SessionCard({
  session,
  active,
  status,
  canFork,
  isWorktree,
  isDragSource,
  onSelect,
  onArchive,
  onFork,
  onCreateWorktree,
  onOpenDependencyMenu,
  onDragHandleStart,
  onDragHandleEnd,
  onDropHere,
}: {
  session: SessionListItem;
  active: boolean;
  status?: SessionStatus;
  canFork: boolean;
  /** True when this session's real cwd differs from the group it's shown
   * under — a worktree checkout, merged into its parent's card list (see
   * Sidebar's effectiveCwd). Purely informational; never changes where
   * onSelect/onCreateWorktree/etc. actually operate. */
  isWorktree: boolean;
  /** True while THIS card is the one being dragged (dims it as feedback) —
   * see ProjectGroup's draggedPath, which this is derived from. */
  isDragSource: boolean;
  onSelect: () => void;
  onArchive: () => void;
  onFork: () => void;
  onCreateWorktree: () => void;
  onOpenDependencyMenu: (anchorRect: DOMRect) => void;
  onDragHandleStart: () => void;
  onDragHandleEnd: () => void;
  onDropHere: () => void;
}) {
  const isTerminal = session.type === "terminal";

  const subMetaItems = [
    isTerminal && session.agentKind ? AGENT_DISPLAY_NAMES[session.agentKind] : null,
    status ? formatRelativeTime(session.modified) : null,
    !isTerminal ? `${session.messageCount} msgs` : null,
  ].filter((v): v is string => Boolean(v));

  return (
    <div
      className={`metaharn-session-card${active ? " metaharn-session-card-active" : ""}`}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        onDropHere();
      }}
      style={{ opacity: isDragSource ? 0.5 : 1 }}
    >
      <div style={{ display: "flex", alignItems: "stretch" }}>
        {/* Drag handle — a separate element from the click-to-select button
            below (not nested inside it: a draggable control inside a
            <button> fights both native button semantics and HTML5 drag
            start). Same technique as TerminalGrid.tsx's own pane-header
            drag handle, the one other place this app reorders by drag. */}
        <div
          className="metaharn-drag-handle metaharn-tooltip"
          aria-label="Drag to reorder"
          draggable
          onDragStart={(e) => {
            onDragHandleStart();
            e.dataTransfer.effectAllowed = "move";
          }}
          onDragEnd={onDragHandleEnd}
          style={{
            width: 18,
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "grab",
            color: "var(--color-text-muted)",
          }}
        >
          <GripIcon size={12} />
        </div>
        <button
          onClick={onSelect}
          style={{
            flex: 1,
            minWidth: 0,
            textAlign: "left",
            border: "none",
            background: "transparent",
            color: "var(--color-text)",
            cursor: "pointer",
            padding: `${SPACE.sm}px ${SPACE.sm + 2}px ${SPACE.sm}px 2px`,
          }}
        >
          <div
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontSize: TEXT.base,
              fontWeight: 600,
              fontFamily: isTerminal ? '"IBM Plex Mono", Menlo, Monaco, monospace' : undefined,
              paddingRight: 20,
            }}
          >
            {isTerminal ? "›_ " : ""}
            {sessionTitle(session)}
          </div>
          <div style={{ marginTop: 4, fontSize: TEXT.xs, display: "flex", alignItems: "center", gap: 5, overflow: "hidden" }}>
            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              <StatusLine status={status} fallback={formatRelativeTime(session.modified)} />
            </span>
            {isWorktree && (
              <span
                className="metaharn-tooltip"
                aria-label="Runs in a separate worktree checkout"
                style={{ display: "inline-flex", color: "var(--color-text-muted)", flexShrink: 0 }}
              >
                <WorktreeIcon size={10} />
              </span>
            )}
          </div>
          {subMetaItems.length > 0 && (
            <div style={{ marginTop: 3, fontSize: TEXT.xs, color: "var(--color-text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {subMetaItems.join(" · ")}
            </div>
          )}
        </button>
      </div>
      <div
        className="metaharn-hover-actions"
        style={{
          position: "absolute",
          top: 4,
          right: 4,
          display: "flex",
          background: "var(--color-bg-elevated)",
          borderRadius: RADIUS.sm,
        }}
      >
        {canFork && (
          <IconButton title="Fork this session" onClick={onFork}>
            <ForkIcon size={13} />
          </IconButton>
        )}
        <IconButton title="New child worktree session" onClick={onCreateWorktree}>
          <WorktreeIcon size={13} />
        </IconButton>
        <IconButton title="Set dependency" onClick={(e) => onOpenDependencyMenu(e.currentTarget.getBoundingClientRect())}>
          <LinkIcon size={13} />
        </IconButton>
        <IconButton title="Archive session" onClick={onArchive}>
          <ArchiveIcon size={13} />
        </IconButton>
      </div>
    </div>
  );
}

export function IconButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick(e);
      }}
      aria-label={title}
      className="metaharn-icon-btn metaharn-tooltip"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        border: "none",
        background: "transparent",
        color: "var(--color-text-muted)",
        cursor: "pointer",
        width: 22,
        height: 22,
        borderRadius: RADIUS.sm,
        flexShrink: 0,
      }}
    >
      {children}
    </button>
  );
}
