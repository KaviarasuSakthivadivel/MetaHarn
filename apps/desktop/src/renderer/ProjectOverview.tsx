import { useEffect, useState } from "react";
import type { AgentInfo, AgentKind, ArchivedSessionItem, SessionListItem, WorktreeLink } from "../preload/preload.js";
import { AGENT_DISPLAY_NAMES, formatRelativeTime, projectLabel, sessionTitle } from "./format.js";
import AgentPickerMenu from "./AgentPickerMenu.js";
import { useSettings } from "./SettingsContext.js";
import { MetaChip, RADIUS, SPACE, TEXT, SegmentedControl } from "./ui.js";
import { ArchiveIcon, BranchIcon, ChatIcon, ClockIcon, DatabaseIcon, ForkIcon, PlayIcon, PlusIcon, SendIcon, TerminalIcon, TrashIcon, WorktreeIcon } from "./icons.js";
import { IconButton, StatusLine, STATUS_LABEL, type SessionStatus } from "./Sidebar.js";

interface ProjectOverviewProps {
  cwd: string;
  sessions: SessionListItem[];
  activeSessionPath?: string;
  installedAgents: AgentInfo[];
  /** Keyed by session.path — see App.tsx's doc comment on how this is derived. */
  sessionStatuses: Map<string, SessionStatus>;
  worktreeLinks: WorktreeLink[];
  onOpenSession: (session: SessionListItem) => void;
  onNewChatSession: () => void;
  onNewTerminalSession: (agentKind: AgentKind) => void;
  /** Reversible — hides a normal session card into the ARCHIVED SESSIONS
   * section below without touching its real file/pty. */
  onArchiveSession: (session: SessionListItem) => void;
  /** Permanent — only reachable from the ARCHIVED SESSIONS section now,
   * same real confirm-dialog flow App.tsx's deleteSession always had. */
  onDeleteSession: (session: SessionListItem) => void;
  /** Un-archives, then opens it the normal way — the ARCHIVED SESSIONS
   * section's Resume button. */
  onResumeArchivedSession: (session: SessionListItem) => void;
  onForkSession: (session: SessionListItem) => void;
  /** Project-scoped "Dream big, start here" box (see HomePage.tsx) — same
   * seeded-launch mechanism, no project picker since cwd is already fixed. */
  onQuickStart: (prompt: string) => void;
  onCreateWorktreeFromProject: () => void;
  /** Permanently removes a real git worktree — App.tsx owns the real
   * uncommitted-changes review + confirmation flow (see removeWorktree
   * there), this just triggers it. */
  onRemoveWorktree: (worktree: { cwd: string; branch: string }) => void;
}

type GroupBy = "none" | "worktree" | "status";
type StatusFilter = "all" | "working" | "waiting" | "idle";
type ViewMode = "grid" | "list";

export default function ProjectOverview({
  cwd,
  sessions,
  activeSessionPath,
  installedAgents,
  sessionStatuses,
  worktreeLinks,
  onOpenSession,
  onNewChatSession,
  onNewTerminalSession,
  onArchiveSession,
  onDeleteSession,
  onResumeArchivedSession,
  onForkSession,
  onQuickStart,
  onCreateWorktreeFromProject,
  onRemoveWorktree,
}: ProjectOverviewProps) {
  const [branch, setBranch] = useState<string | null>(null);
  const [showAgentPicker, setShowAgentPicker] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [groupBy, setGroupBy] = useState<GroupBy>("none");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  // Starts collapsed only when there's nothing in it yet — same
  // "don't claim space for an empty section" call ARCHIVED SESSIONS below
  // already makes, but a project that actually has worktrees still opens
  // to them visible, not hidden behind an extra click every time.
  const [worktreesCollapsed, setWorktreesCollapsed] = useState(
    () => worktreeLinks.filter((l) => l.parentCwd === cwd).length === 0,
  );
  const [progressByPath, setProgressByPath] = useState<Map<string, number>>(new Map());
  const [gitStatusByCwd, setGitStatusByCwd] = useState<Map<string, "clean" | "dirty" | null>>(new Map());
  const [archivedOpen, setArchivedOpen] = useState(false);
  // Fetched lazily, only once the section is actually opened — same
  // per-section lazy-fetch principle ProjectsListPage.tsx's own Archived
  // section already uses for projects, applied here to sessions.
  const [archivedSessions, setArchivedSessions] = useState<ArchivedSessionItem[] | undefined>(undefined);
  const { defaultAgentKind } = useSettings();

  const refreshArchivedSessions = () => {
    void window.metaharn.listArchivedSessions(cwd).then(setArchivedSessions);
  };

  useEffect(() => {
    if (archivedOpen && archivedSessions === undefined) refreshArchivedSessions();
  }, [archivedOpen, archivedSessions]);

  // Wrap the App.tsx-level handlers so this page's own local
  // archivedSessions list stays in sync — archiving a session should make
  // it disappear from the active grid AND appear in ARCHIVED SESSIONS
  // without a manual reopen; resuming/deleting the reverse.
  const archiveSession = (session: SessionListItem) => {
    onArchiveSession(session);
    setArchivedSessions(undefined);
  };
  const resumeArchivedSession = (session: SessionListItem) => {
    onResumeArchivedSession(session);
    setArchivedSessions(undefined);
  };
  const deleteArchivedSession = (session: SessionListItem) => {
    onDeleteSession(session);
    setArchivedSessions(undefined);
  };

  const defaultInstalled = installedAgents.find((a) => a.kind === defaultAgentKind);
  const handleNewTerminalClick = () => {
    if (installedAgents.length === 0) return;
    if (defaultInstalled) {
      onNewTerminalSession(defaultInstalled.kind);
      return;
    }
    if (installedAgents.length === 1) {
      onNewTerminalSession(installedAgents[0].kind);
      return;
    }
    setShowAgentPicker(true);
  };

  useEffect(() => {
    setBranch(null);
    void window.metaharnFiles.getGitBranch(cwd).then(setBranch);
  }, [cwd]);

  // Worktrees whose parent is THIS project — the WORKTREES section below,
  // and also what pulls a worktree's own sessions into this page's grid
  // (see projectSessions) instead of only showing exact-cwd matches.
  const worktreesForProject = worktreeLinks.filter((l) => l.parentCwd === cwd);
  const worktreeLinkByCwd = new Map(worktreesForProject.map((l) => [l.cwd, l]));
  const worktreeCwds = new Set(worktreeLinkByCwd.keys());

  const projectSessions = sessions
    .filter((s) => s.cwd === cwd || worktreeCwds.has(s.cwd))
    .sort((a, b) => b.modified.getTime() - a.modified.getTime());

  const chatCount = projectSessions.filter((s) => s.type === "chat").length;
  const terminalCount = projectSessions.length - chatCount;
  const lastActivity = projectSessions[0]?.modified;

  // Real context-window usage per session (SessionStats.contextUsage.percent)
  // — fetched, never fabricated: a chat session other than the one currently
  // open in this window has no live stats source at all (see
  // 08-known-limitations.md's one-Pi-session-per-window note) and just gets
  // no progress bar rather than a fake number.
  const terminalKey = projectSessions.filter((s) => s.type === "terminal").map((s) => s.path).join(",");
  useEffect(() => {
    let cancelled = false;
    const terminalSessions = projectSessions.filter((s) => s.type === "terminal");
    const openChat = projectSessions.find((s) => s.type === "chat" && s.path === activeSessionPath);
    Promise.all([
      ...terminalSessions.map((s) =>
        window.metaharn.getTerminalSessionStats(s.cwd, s.id).then((stats) => [s.path, stats?.contextUsage?.percent ?? null] as const),
      ),
      ...(openChat
        ? [window.metaharn.getSessionStats().then((stats) => [openChat.path, stats?.contextUsage?.percent ?? null] as const)]
        : []),
    ]).then((results) => {
      if (cancelled) return;
      const next = new Map<string, number>();
      for (const [path, pct] of results) if (pct != null) next.set(path, pct);
      setProgressByPath(next);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalKey, activeSessionPath]);

  // Real `git status --porcelain` per worktree — never a guessed "clean".
  useEffect(() => {
    let cancelled = false;
    Promise.all(worktreesForProject.map((l) => window.metaharnFiles.getGitStatus(l.cwd).then((s) => [l.cwd, s] as const))).then(
      (results) => {
        if (cancelled) return;
        setGitStatusByCwd(new Map(results));
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worktreesForProject.map((l) => l.cwd).join(",")]);

  const filtered = statusFilter === "all" ? projectSessions : projectSessions.filter((s) => sessionStatuses.get(s.path) === statusFilter);

  interface Group {
    key: string;
    label: string;
    sessions: SessionListItem[];
  }
  let groups: Group[];
  if (groupBy === "worktree") {
    const byCwd = new Map<string, SessionListItem[]>();
    for (const s of filtered) {
      const list = byCwd.get(s.cwd) ?? [];
      list.push(s);
      byCwd.set(s.cwd, list);
    }
    groups = [...byCwd.entries()]
      .map(([sessionCwd, list]) => ({
        key: sessionCwd,
        label: sessionCwd === cwd ? "main" : (worktreeLinkByCwd.get(sessionCwd)?.branch ?? projectLabel(sessionCwd)),
        sessions: list,
      }))
      .sort((a, b) => (a.key === cwd ? -1 : b.key === cwd ? 1 : 0));
  } else if (groupBy === "status") {
    const order: (SessionStatus | "none")[] = ["working", "waiting", "active", "idle", "exited", "none"];
    const byStatus = new Map<string, SessionListItem[]>();
    for (const s of filtered) {
      const key = sessionStatuses.get(s.path) ?? "none";
      const list = byStatus.get(key) ?? [];
      list.push(s);
      byStatus.set(key, list);
    }
    groups = order
      .filter((k) => byStatus.has(k))
      .map((k) => ({ key: k, label: k === "none" ? "No live status" : STATUS_LABEL[k], sessions: byStatus.get(k)! }));
  } else {
    groups = [{ key: "all", label: "", sessions: filtered }];
  }

  const handleQuickStart = () => {
    if (!prompt.trim()) return;
    onQuickStart(prompt.trim());
    setPrompt("");
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", gap: SPACE.lg, overflowY: "auto" }}>
      <div>
        <h2 style={{ margin: 0 }}>{projectLabel(cwd)}</h2>
        <p
          style={{
            margin: "2px 0",
            color: "var(--color-text-muted)",
            fontSize: TEXT.sm,
            fontFamily: '"IBM Plex Mono", Menlo, Monaco, monospace',
          }}
        >
          {cwd}
          {branch ? ` · ${branch}` : ""}
        </p>
        {projectSessions.length > 0 && (
          <div style={{ display: "flex", gap: SPACE.lg, fontSize: TEXT.sm, color: "var(--color-text-secondary)", marginTop: SPACE.sm }}>
            <MetaChip icon={<ChatIcon size={13} />}>
              {chatCount} chat{chatCount === 1 ? "" : "s"}
            </MetaChip>
            <MetaChip icon={<TerminalIcon size={13} />}>
              {terminalCount} terminal{terminalCount === 1 ? "" : "s"}
            </MetaChip>
            {lastActivity && <MetaChip icon={<ClockIcon size={13} />}>active {formatRelativeTime(lastActivity)}</MetaChip>}
          </div>
        )}
      </div>

      {/* Project-scoped quick-start — same launcher as HomePage.tsx, minus
          the project picker (this project IS the target). */}
      <div style={{ position: "relative", flexShrink: 0 }}>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleQuickStart();
            }
          }}
          rows={2}
          placeholder="Describe what you want to build — starts a new terminal session here."
          style={{
            width: "100%",
            resize: "none",
            padding: `${SPACE.sm + 2}px ${SPACE.md + 32}px ${SPACE.sm + 2}px ${SPACE.md}px`,
            border: "1px solid var(--color-border)",
            borderRadius: RADIUS.lg,
            background: "var(--color-bg-elevated)",
            color: "var(--color-text)",
            fontSize: TEXT.base,
            fontFamily: "inherit",
            lineHeight: 1.5,
          }}
        />
        <button
          onClick={handleQuickStart}
          disabled={!prompt.trim()}
          aria-label="Start session"
          className="metaharn-tooltip"
          style={{
            position: "absolute",
            right: SPACE.sm,
            bottom: SPACE.sm,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 28,
            height: 28,
            border: "none",
            borderRadius: RADIUS.md,
            background: prompt.trim() ? "var(--color-accent)" : "var(--color-bg-hover)",
            color: prompt.trim() ? "#fff" : "var(--color-text-muted)",
            cursor: prompt.trim() ? "pointer" : "default",
          }}
        >
          <SendIcon size={14} />
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {/* Toolbar: what you can DO (new session) on the left, how the list
            below is arranged on the right — separated from the ACTIVE
            heading itself so this row reads as controls, not content. The
            arrange controls only mean anything once there's more than one
            session to arrange, so they don't show up as dead chrome on a
            fresh project. */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: SPACE.md, flexWrap: "wrap", gap: SPACE.sm }}>
          <div style={{ display: "flex", alignItems: "center", gap: SPACE.xs }}>
            <div style={{ position: "relative", display: "flex" }}>
              <button
                onClick={handleNewTerminalClick}
                disabled={installedAgents.length === 0}
                title={installedAgents.length === 0 ? "No supported agent CLI found on PATH" : undefined}
                style={{
                  padding: "6px 12px",
                  border: "1px solid var(--color-border)",
                  borderRight: installedAgents.length > 1 ? "none" : undefined,
                  borderRadius: installedAgents.length > 1 ? `${RADIUS.md}px 0 0 ${RADIUS.md}px` : RADIUS.md,
                  background: "transparent",
                  cursor: installedAgents.length === 0 ? "default" : "pointer",
                  color: installedAgents.length === 0 ? "var(--color-text-muted)" : "var(--color-text-secondary)",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: TEXT.sm,
                  whiteSpace: "nowrap",
                }}
              >
                <PlusIcon size={12} /> New terminal
              </button>
              {installedAgents.length > 1 && (
                <button
                  onClick={() => setShowAgentPicker(true)}
                  aria-label="Choose a different agent for this session"
                  className="metaharn-tooltip"
                  style={{
                    padding: `0 ${SPACE.sm}px`,
                    border: "1px solid var(--color-border)",
                    borderRadius: `0 ${RADIUS.md}px ${RADIUS.md}px 0`,
                    background: "transparent",
                    cursor: "pointer",
                    color: "var(--color-text-secondary)",
                  }}
                >
                  ▾
                </button>
              )}
              {showAgentPicker && (
                <AgentPickerMenu
                  agents={installedAgents}
                  onPick={(kind) => {
                    setShowAgentPicker(false);
                    onNewTerminalSession(kind);
                  }}
                  onClose={() => setShowAgentPicker(false)}
                />
              )}
            </div>
            <button
              onClick={onNewChatSession}
              style={{
                padding: "6px 12px",
                border: "1px solid var(--color-border)",
                borderRadius: RADIUS.md,
                background: "transparent",
                cursor: "pointer",
                color: "var(--color-text-secondary)",
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: TEXT.sm,
                whiteSpace: "nowrap",
              }}
            >
              <PlusIcon size={12} /> New chat
            </button>
          </div>

          {projectSessions.length > 1 && (
            <div style={{ display: "flex", alignItems: "center", gap: SPACE.sm, flexWrap: "wrap" }}>
              <SegmentedControl
                value={statusFilter}
                onChange={setStatusFilter}
                options={[
                  { value: "all", label: "All" },
                  { value: "working", label: "Working" },
                  { value: "waiting", label: "Waiting" },
                  { value: "idle", label: "Idle" },
                ]}
              />
              <ToolbarDivider />
              <SegmentedControl
                value={groupBy}
                onChange={setGroupBy}
                options={[
                  { value: "none", label: "No grouping" },
                  { value: "worktree", label: "Worktree" },
                  { value: "status", label: "Status" },
                ]}
              />
              <ToolbarDivider />
              <SegmentedControl
                value={viewMode}
                onChange={setViewMode}
                options={[
                  { value: "grid", label: "Grid" },
                  { value: "list", label: "List" },
                ]}
              />
            </div>
          )}
        </div>

        <div style={{ marginBottom: SPACE.sm }}>
          <SectionLabel label="Active" count={projectSessions.length} />
        </div>

        {projectSessions.length === 0 && (
          <p style={{ color: "var(--color-text-muted)", fontSize: TEXT.base }}>No sessions yet.</p>
        )}
        {filtered.length === 0 && projectSessions.length > 0 && (
          <p style={{ color: "var(--color-text-muted)", fontSize: TEXT.base }}>No sessions match this filter.</p>
        )}

        {groups.map((group) => (
          <div key={group.key} style={{ marginBottom: SPACE.lg }}>
            {group.label && (
              <div style={{ fontSize: TEXT.xs, fontWeight: 700, letterSpacing: 0.5, color: "var(--color-text-muted)", marginBottom: SPACE.sm }}>
                {group.label.toUpperCase()}
              </div>
            )}
            <div
              style={
                viewMode === "grid"
                  ? { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: SPACE.sm }
                  : { display: "flex", flexDirection: "column", gap: SPACE.sm }
              }
            >
              {group.sessions.map((session) => (
                <OverviewSessionCard
                  key={session.path}
                  session={session}
                  active={session.path === activeSessionPath}
                  status={sessionStatuses.get(session.path)}
                  progress={progressByPath.get(session.path)}
                  branch={session.cwd === cwd ? branch : (worktreeLinkByCwd.get(session.cwd)?.branch ?? null)}
                  isWorktree={session.cwd !== cwd}
                  onSelect={() => onOpenSession(session)}
                  onArchive={() => archiveSession(session)}
                  onFork={() => onForkSession(session)}
                />
              ))}
            </div>
          </div>
        ))}

        <div style={{ marginTop: SPACE.xl, paddingTop: SPACE.lg, borderTop: "1px solid var(--color-border)" }}>
          <div style={{ marginBottom: SPACE.sm }}>
            <SectionLabel
              icon={<WorktreeIcon size={13} />}
              label="Worktrees"
              count={worktreesForProject.length}
              collapsed={worktreesCollapsed}
              onToggle={() => setWorktreesCollapsed((v) => !v)}
            />
          </div>
          {!worktreesCollapsed && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: SPACE.sm }}>
              <WorktreeCard
                folderName="main"
                branch={branch}
                subtitle={projectSessions.find((s) => s.cwd === cwd) ? sessionTitle(projectSessions.find((s) => s.cwd === cwd)!) : undefined}
              />
              {worktreesForProject.map((link) => (
                <WorktreeCard
                  key={link.cwd}
                  folderName={projectLabel(link.cwd)}
                  branch={link.branch}
                  gitStatus={gitStatusByCwd.get(link.cwd)}
                  createdAt={link.createdAt}
                  onRemove={() => onRemoveWorktree({ cwd: link.cwd, branch: link.branch })}
                />
              ))}
              <button
                onClick={onCreateWorktreeFromProject}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                  padding: SPACE.md,
                  border: "1px dashed var(--color-border)",
                  borderRadius: RADIUS.md,
                  background: "transparent",
                  cursor: "pointer",
                  color: "var(--color-text-secondary)",
                  fontSize: TEXT.sm,
                  minHeight: 64,
                }}
              >
                <PlusIcon size={13} /> New
              </button>
            </div>
          )}
        </div>

        <div style={{ marginTop: SPACE.lg, paddingTop: SPACE.lg, borderTop: "1px solid var(--color-border)" }}>
          <div style={{ marginBottom: SPACE.sm }}>
            <SectionLabel
              icon={<ArchiveIcon size={13} />}
              label="Archived sessions"
              count={archivedSessions?.length}
              collapsed={!archivedOpen}
              onToggle={() => setArchivedOpen((v) => !v)}
            />
          </div>
          {archivedOpen && (
            <div style={{ display: "flex", flexDirection: "column", gap: SPACE.sm }}>
              {archivedSessions === undefined && (
                <p style={{ fontSize: TEXT.sm, color: "var(--color-text-muted)" }}>Loading...</p>
              )}
              {archivedSessions?.length === 0 && (
                <p style={{ fontSize: TEXT.sm, color: "var(--color-text-muted)" }}>No archived sessions.</p>
              )}
              {archivedSessions?.map((session) => (
                <ArchivedSessionRow
                  key={session.path}
                  session={session}
                  onResume={() => resumeArchivedSession(session)}
                  onDelete={() => deleteArchivedSession(session)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Deliberately plainer than the active OverviewSessionCard — no status/
 * progress/branch fetch, this is a secondary, out-of-the-way surface, not
 * the main working list (same call ProjectsListPage.tsx's own ArchivedRow
 * already made for archived projects). */
function ArchivedSessionRow({
  session,
  onResume,
  onDelete,
}: {
  session: ArchivedSessionItem;
  onResume: () => void;
  onDelete: () => void;
}) {
  const isTerminal = session.type === "terminal";
  return (
    <div
      className="metaharn-card-row"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: SPACE.sm,
        border: "1px solid var(--color-border)",
        borderRadius: RADIUS.md,
        padding: `${SPACE.sm}px ${SPACE.md}px`,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: TEXT.base,
            fontWeight: 600,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontFamily: isTerminal ? '"IBM Plex Mono", Menlo, Monaco, monospace' : undefined,
          }}
        >
          {isTerminal ? "›_ " : ""}
          {sessionTitle(session)}
        </div>
        <div style={{ fontSize: 10.5, color: "var(--color-text-muted)", marginTop: 2 }}>
          archived {formatRelativeTime(session.archivedAt)}
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
        <button
          onClick={onResume}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            border: "none",
            borderRadius: RADIUS.sm,
            background: "var(--color-accent)",
            color: "#fff",
            cursor: "pointer",
            padding: "4px 9px",
            fontSize: TEXT.xs,
            fontWeight: 600,
          }}
        >
          <PlayIcon size={10} /> Resume
        </button>
        <IconButton title="Delete permanently" onClick={onDelete}>
          <TrashIcon size={13} />
        </IconButton>
      </div>
    </div>
  );
}

/** A thin vertical rule between unrelated control clusters in a toolbar row
 * (e.g. "filter by status" vs. "arrange as grid/list") — the space alone
 * between SegmentedControls read as one long run of buttons; this gives the
 * eye a place to split them into groups without adding a label to each. */
function ToolbarDivider() {
  return <div style={{ width: 1, height: 18, background: "var(--color-border)" }} />;
}

/** One consistent header treatment for every section on this page (ACTIVE,
 * WORKTREES, ARCHIVED SESSIONS) — icon + label + count badge, optionally
 * collapsible. Previously each of the three hand-rolled its own slightly
 * different version (ACTIVE's own count-chip styling never made it to the
 * other two, WORKTREES/ARCHIVED used plain "(N)" text) — one component
 * instead of three near-duplicates that had quietly drifted apart. */
function SectionLabel({
  icon,
  label,
  count,
  collapsed,
  onToggle,
}: {
  icon?: React.ReactNode;
  label: string;
  count?: number;
  /** Omit both to render a static, non-interactive heading (ACTIVE). */
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const content = (
    <>
      {onToggle && <span style={{ fontSize: 10, width: 10, color: "var(--color-text-muted)" }}>{collapsed ? "▸" : "▾"}</span>}
      {icon && <span style={{ display: "inline-flex", color: "var(--color-text-muted)" }}>{icon}</span>}
      <span style={{ fontSize: TEXT.xs, fontWeight: 700, letterSpacing: 0.5, color: "var(--color-text-muted)" }}>
        {label.toUpperCase()}
      </span>
      {count != null && (
        <span
          style={{
            fontSize: TEXT.xs,
            fontWeight: 700,
            color: "var(--color-text)",
            background: "var(--color-bg-hover)",
            borderRadius: RADIUS.sm,
            padding: "1px 7px",
          }}
        >
          {count}
        </span>
      )}
    </>
  );
  const rowStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6 };
  if (!onToggle) return <div style={rowStyle}>{content}</div>;
  return (
    <button onClick={onToggle} style={{ ...rowStyle, border: "none", background: "transparent", cursor: "pointer", padding: 0 }}>
      {content}
    </button>
  );
}

function OverviewSessionCard({
  session,
  active,
  status,
  progress,
  branch,
  isWorktree,
  onSelect,
  onArchive,
  onFork,
}: {
  session: SessionListItem;
  active: boolean;
  status?: SessionStatus;
  progress?: number;
  branch: string | null;
  isWorktree: boolean;
  onSelect: () => void;
  onArchive: () => void;
  onFork: () => void;
}) {
  const isTerminal = session.type === "terminal";
  // A chat session can only be forked while it's the one live in the
  // window's single Pi AgentSession — same constraint Sidebar.tsx's
  // canFork applies (see forkChatSession's doc comment in App.tsx). A
  // terminal session has no such constraint.
  const canFork = isTerminal || active;

  return (
    <div
      className="metaharn-card-row"
      style={{
        position: "relative",
        border: `1px solid ${active ? "var(--color-accent)" : "var(--color-border)"}`,
        borderRadius: RADIUS.md,
        background: "var(--color-bg-elevated)",
        padding: SPACE.sm + 2,
      }}
    >
      <button
        onClick={onSelect}
        style={{
          display: "block",
          width: "100%",
          textAlign: "left",
          border: "none",
          background: "transparent",
          color: "var(--color-text)",
          cursor: "pointer",
          padding: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: SPACE.sm }}>
          <span style={{ fontSize: TEXT.xs, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            <StatusLine status={status} fallback="No live status" />
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 10.5, color: "var(--color-text-muted)", flexShrink: 0 }}>
            <ClockIcon size={10} />
            {formatRelativeTime(session.modified)}
          </span>
        </div>

        <div
          style={{
            marginTop: 6,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: TEXT.md,
            fontWeight: 600,
            paddingRight: 20,
            fontFamily: isTerminal ? '"IBM Plex Mono", Menlo, Monaco, monospace' : undefined,
          }}
        >
          {isTerminal ? "›_ " : ""}
          {sessionTitle(session)}
        </div>

        {branch && (
          <div style={{ marginTop: 3, display: "flex", alignItems: "center", gap: 4, fontSize: 10.5, color: "var(--color-text-muted)" }}>
            {isWorktree ? <WorktreeIcon size={10} /> : <BranchIcon size={10} />}
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{branch}</span>
            {isTerminal && session.agentKind && session.agentKind !== "claude" && <span>· {AGENT_DISPLAY_NAMES[session.agentKind]}</span>}
          </div>
        )}

        {progress != null && (
          <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 6 }}>
            <DatabaseIcon size={11} />
            <div style={{ flex: 1, height: 3, borderRadius: 2, background: "var(--color-bg-hover)", overflow: "hidden" }}>
              <div style={{ width: `${Math.min(100, Math.max(0, progress))}%`, height: "100%", background: "var(--color-accent)" }} />
            </div>
            <span style={{ fontSize: 10, color: "var(--color-text-muted)" }}>{Math.round(progress)}%</span>
          </div>
        )}
      </button>

      <div
        className="metaharn-hover-actions"
        style={{
          position: "absolute",
          top: SPACE.sm,
          right: SPACE.sm,
          display: "flex",
          alignItems: "center",
          gap: 4,
          background: "var(--color-bg-elevated)",
          borderRadius: RADIUS.sm,
        }}
      >
        {/* Same action clicking the card body already does (onSelect) — an
            explicit, labeled button for it too, since a past session in a
            long history list is easy to miss is even clickable at a glance.
            Not shown for the currently-open session; there's nothing to
            resume into. */}
        {!active && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onSelect();
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              border: "none",
              borderRadius: RADIUS.sm,
              background: "var(--color-accent)",
              color: "#fff",
              cursor: "pointer",
              padding: "4px 9px",
              fontSize: TEXT.xs,
              fontWeight: 600,
            }}
          >
            <PlayIcon size={10} /> Resume
          </button>
        )}
        {canFork && (
          <IconButton title="Fork this session" onClick={onFork}>
            <ForkIcon size={13} />
          </IconButton>
        )}
        <IconButton title="Archive session" onClick={onArchive}>
          <ArchiveIcon size={13} />
        </IconButton>
      </div>
    </div>
  );
}

function WorktreeCard({
  folderName,
  branch,
  subtitle,
  gitStatus,
  createdAt,
  onRemove,
}: {
  folderName: string;
  branch: string | null;
  subtitle?: string;
  gitStatus?: "clean" | "dirty" | null;
  createdAt?: Date;
  /** Absent for the `main` card — the primary checkout isn't a worktree
   * and can't be removed this way. */
  onRemove?: () => void;
}) {
  return (
    <div
      className={onRemove ? "metaharn-card-row" : undefined}
      style={{
        position: "relative",
        border: "1px solid var(--color-border)",
        borderRadius: RADIUS.md,
        background: "var(--color-bg-elevated)",
        padding: SPACE.sm + 2,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: TEXT.sm, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", paddingRight: onRemove ? 20 : 0 }}>
        <WorktreeIcon size={12} />
        {folderName}
      </div>
      {onRemove && (
        <div className="metaharn-hover-actions" style={{ position: "absolute", top: 6, right: 6, display: "flex", background: "var(--color-bg-elevated)", borderRadius: RADIUS.sm }}>
          <IconButton title="Remove worktree" onClick={onRemove}>
            <TrashIcon size={13} />
          </IconButton>
        </div>
      )}
      {branch && (
        <div style={{ marginTop: 3, display: "flex", alignItems: "center", gap: 4, fontSize: 10.5, color: "var(--color-text-muted)" }}>
          <BranchIcon size={10} />
          {branch}
        </div>
      )}
      {subtitle && (
        <div style={{ marginTop: 3, fontSize: 10.5, color: "var(--color-text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {subtitle}
        </div>
      )}
      {(gitStatus || createdAt) && (
        <div style={{ marginTop: 6, display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 10.5, color: "var(--color-text-muted)" }}>
          {gitStatus && <span style={{ color: gitStatus === "clean" ? "var(--color-status-working)" : "var(--color-status-waiting)" }}>{gitStatus}</span>}
          {createdAt && <span>created {formatRelativeTime(createdAt)}</span>}
        </div>
      )}
    </div>
  );
}
