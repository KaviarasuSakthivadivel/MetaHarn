import { useEffect, useState } from "react";
import type { AgentInfo, AgentKind, ArchivedSessionItem, SessionListItem, WorktreeLink } from "../preload/preload.js";
import { AGENT_DISPLAY_NAMES, formatRelativeTime, projectLabel, sessionTitle } from "./format.js";
import AgentPickerMenu from "./AgentPickerMenu.js";
import { useSettings } from "./SettingsContext.js";
import { RADIUS, SPACE, TEXT, SegmentedControl } from "./ui.js";
import FolderIconBadge from "./FolderIconBadge.js";
import { ArchiveIcon, BranchIcon, ChatIcon, ClockIcon, DatabaseIcon, EditIcon, ForkIcon, PlayIcon, PlusIcon, SendIcon, TerminalIcon, TrashIcon, WorktreeIcon } from "./icons.js";
import { IconButton, StatusLine, STATUS_LABEL, type SessionStatus } from "./Sidebar.js";

interface ProjectOverviewProps {
  cwd: string;
  /** The registered project's real display name, natural case — undefined for an unregistered
   * cwd, where projectLabel(cwd) (last path segment, upper-cased) is the only name there is. */
  projectName?: string;
  sessions: SessionListItem[];
  activeSessionPath?: string;
  installedAgents: AgentInfo[];
  /** Keyed by session.path — see App.tsx's doc comment on how this is derived. */
  sessionStatuses: Map<string, SessionStatus>;
  worktreeLinks: WorktreeLink[];
  onOpenSession: (session: SessionListItem) => void;
  onNewChatSession: () => void;
  onNewTerminalSession: (agentKind: AgentKind) => void;
  /** The AgentPickerMenu's Install link for a not-yet-installed agent. */
  onGoToSettings: () => void;
  onRenameSession: (session: SessionListItem, title: string) => void;
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
  projectName,
  sessions,
  activeSessionPath,
  installedAgents,
  sessionStatuses,
  worktreeLinks,
  onOpenSession,
  onNewChatSession,
  onNewTerminalSession,
  onGoToSettings,
  onRenameSession,
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
  const [sessionQuery, setSessionQuery] = useState("");
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

  const statusFiltered = statusFilter === "all" ? projectSessions : projectSessions.filter((s) => sessionStatuses.get(s.path) === statusFilter);
  const query = sessionQuery.trim().toLowerCase();
  const filtered = query ? statusFiltered.filter((s) => sessionTitle(s).toLowerCase().includes(query)) : statusFiltered;

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
      .map((k) => ({ key: k, label: k === "none" ? "Idle" : STATUS_LABEL[k], sessions: byStatus.get(k)! }));
  } else {
    groups = [{ key: "all", label: "", sessions: filtered }];
  }

  const handleQuickStart = () => {
    if (!prompt.trim()) return;
    onQuickStart(prompt.trim());
    setPrompt("");
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflowY: "auto" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: SPACE.lg, maxWidth: 1040, width: "100%" }}>
        {/* Icon + name only — no path/branch/counts line underneath. That metadata (branch
            especially) isn't lost: it's one scroll down, on the "main" WorktreeCard in the
            WORKTREES section, which is where every OTHER checkout's branch already lives too —
            this header shouldn't be the one place carrying it redundantly. The raw cwd path is
            available as this whole block's title attribute instead of printed inline. Prefers
            the registered project's real name (natural case) over projectLabel(cwd)'s
            upper-cased last-path-segment fallback — that fallback exists for unregistered
            cwds, which don't have a real name to show at all, not as this page's everyday look. */}
        <div style={{ display: "flex", alignItems: "center", gap: SPACE.md }} title={cwd}>
          <FolderIconBadge size={56} />
          <h1 style={{ margin: 0 }}>{projectName ?? projectLabel(cwd)}</h1>
        </div>

        {/* Quick-start composer — one bordered unit, not two: the prompt box (seeds a new
            terminal with what you typed) and the "or start blank" tiles (Terminal/Chat, no
            prompt) used to be two separate floating cards with a gap between them, which read as
            an accidental layout more than a designed composer-with-actions. Same real launcher
            as HomePage.tsx, minus the project picker (this project IS the target). */}
        <div className="metaharn-composer" style={{ border: "1px solid var(--color-border)", borderRadius: RADIUS.xl, background: "var(--color-bg-elevated)", boxShadow: "var(--shadow-sm)", overflow: "hidden", flexShrink: 0 }}>
          <div style={{ position: "relative" }}>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleQuickStart();
                }
              }}
              rows={3}
              placeholder="Describe what you want to build — starts a new terminal session here."
              style={{
                display: "block",
                width: "100%",
                resize: "none",
                padding: `${SPACE.md}px ${SPACE.md + 32}px ${SPACE.md}px ${SPACE.lg}px`,
                border: "none",
                borderRadius: 0,
                background: "transparent",
                color: "var(--color-text)",
                fontSize: TEXT.md,
                fontFamily: "inherit",
                lineHeight: 1.5,
                boxShadow: "none",
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
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: SPACE.sm,
              padding: `${SPACE.sm}px ${SPACE.lg}px`,
              borderTop: "1px solid var(--color-border)",
              background: "var(--color-bg-secondary)",
            }}
          >
            <span style={{ fontSize: TEXT.xs, color: "var(--color-text-muted)", marginRight: SPACE.xs }}>or start blank</span>
            <div style={{ position: "relative", display: "flex" }}>
              <LaunchTile
                icon={<TerminalIcon size={18} />}
                label="Terminal"
                onClick={handleNewTerminalClick}
                disabled={installedAgents.length === 0}
                title={installedAgents.length === 0 ? "No supported agent CLI found on PATH" : undefined}
                compact
              />
              {/* Always reachable, even with zero or one agent installed — this is the one place
                  a user can discover and install the OTHER agent CLIs (see AgentPickerMenu,
                  which now lists every known kind with an Install link, not just installed
                  ones). */}
              <button
                onClick={() => setShowAgentPicker(true)}
                aria-label="Choose an agent for this session"
                className="metaharn-tooltip"
                style={{
                  position: "absolute",
                  top: 3,
                  right: 3,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 14,
                  height: 14,
                  borderRadius: 4,
                  background: "var(--color-bg-hover)",
                  color: "var(--color-text-muted)",
                  fontSize: 8,
                }}
              >
                ▾
              </button>
              {showAgentPicker && (
                <AgentPickerMenu
                  installedKinds={installedAgents.map((a) => a.kind)}
                  onPick={(kind) => {
                    setShowAgentPicker(false);
                    onNewTerminalSession(kind);
                  }}
                  onGoToInstall={() => {
                    setShowAgentPicker(false);
                    onGoToSettings();
                  }}
                  onClose={() => setShowAgentPicker(false)}
                />
              )}
            </div>
            <LaunchTile icon={<ChatIcon size={18} />} label="Chat" onClick={onNewChatSession} compact />
          </div>
        </div>

        <div style={{ flex: 1, minHeight: 0 }}>
          {/* Toolbar: what you can DO (new session) on the left, how the list
              below is arranged on the right — separated from the ACTIVE
              heading itself so this row reads as controls, not content. The
              arrange controls only mean anything once there's more than one
              session to arrange, so they don't show up as dead chrome on a
              fresh project. */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: SPACE.md, flexWrap: "wrap", gap: SPACE.sm }}>
            <ActiveBadge count={projectSessions.length} />

            {projectSessions.length > 1 && (
              <div style={{ display: "flex", alignItems: "center", gap: SPACE.sm, flexWrap: "wrap" }}>
                <input
                  value={sessionQuery}
                  onChange={(e) => setSessionQuery(e.target.value)}
                  placeholder="Search sessions…"
                  style={{
                    padding: "5px 10px",
                    fontSize: TEXT.sm,
                    borderRadius: RADIUS.md,
                    width: 160,
                  }}
                />
                <ToolbarDivider />
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

          {/* No outer Card wrapper here — a grid of session cards, each already bordered in its
              own right, inside ANOTHER bordered container was card-inside-a-card: two
              boundaries competing right next to each other instead of one clean one. A GRID of
              peer items (unlike the sidebar's single-column list, where position alone separates
              rows) needs each item to carry its own visible edge to read as organized at all —
              that's what OverviewSessionCard itself provides now. */}
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
                    onRename={(title) => onRenameSession(session, title)}
                    onArchive={() => archiveSession(session)}
                    onFork={() => onForkSession(session)}
                  />
                ))}
              </div>
            </div>
          ))}

          <div style={{ marginTop: SPACE.xl }}>
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
              <Card>
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
              </Card>
            )}
          </div>

          <div style={{ marginTop: SPACE.lg, marginBottom: SPACE.xl }}>
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
              <Card>
                <div style={{ display: "flex", flexDirection: "column", gap: SPACE.sm }}>
                  {archivedSessions === undefined && (
                    <p style={{ margin: 0, fontSize: TEXT.sm, color: "var(--color-text-muted)" }}>Loading...</p>
                  )}
                  {archivedSessions?.length === 0 && (
                    <p style={{ margin: 0, fontSize: TEXT.sm, color: "var(--color-text-muted)" }}>No archived sessions.</p>
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
              </Card>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Bordered, padded container — gives even a single-item section (a sparse, freshly-created
 * project might have exactly one session and zero worktrees) a real, finished-looking boundary
 * instead of content sitting directly on the page background with nothing marking where the
 * section ends. Mirrors SettingsPage.tsx's own local Card. */
function Card({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        border: "1px solid var(--color-border)",
        borderRadius: RADIUS.lg,
        background: "var(--color-bg-elevated)",
        boxShadow: "var(--shadow-sm)",
        padding: SPACE.lg,
      }}
    >
      {children}
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

/** A launch action as a square icon-over-label tile instead of a small text-and-icon pill
 * button — replaces "+ New terminal"/"+ New chat", which read as administrative chrome buried
 * in a toolbar row rather than the primary thing you came to this page to do. Bigger, centered,
 * with real hover lift, so the two actions this page actually exists for are the visually
 * loudest thing below the quick-start box. */
/** `compact`: a short, horizontal pill (icon beside label) sized for the quick-start composer's
 * own footer strip — the original square icon-over-label tile is still the default shape,
 * available for anywhere this needs to be the loud, primary action rather than a secondary one
 * tucked under a composer. */
function LaunchTile({
  icon,
  label,
  onClick,
  disabled,
  title,
  compact,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  compact?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="metaharn-launch-tile"
      style={
        compact
          ? {
              display: "flex",
              alignItems: "center",
              gap: 7,
              padding: "7px 14px",
              border: "1px solid var(--color-border)",
              borderRadius: RADIUS.md,
              background: "var(--color-bg-elevated)",
              color: disabled ? "var(--color-text-muted)" : "var(--color-text-secondary)",
              cursor: disabled ? "default" : "pointer",
              fontSize: TEXT.sm,
              fontWeight: 600,
            }
          : {
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 7,
              width: 96,
              height: 78,
              flexShrink: 0,
              border: "1px solid var(--color-border)",
              borderRadius: RADIUS.lg,
              background: "var(--color-bg-elevated)",
              color: disabled ? "var(--color-text-muted)" : "var(--color-text-secondary)",
              cursor: disabled ? "default" : "pointer",
              fontSize: TEXT.sm,
              fontWeight: 600,
              boxShadow: "var(--shadow-sm)",
            }
      }
    >
      {icon}
      {label}
    </button>
  );
}

/** The "Active" section header as a filled pill badge (label + count together) instead of plain
 * small-caps text with a separate count chip — a bolder, more scannable anchor for the busiest
 * section on this page. The secondary WORKTREES/ARCHIVED SESSIONS sections below keep
 * SectionLabel's quieter plain-text treatment, since those are collapsed-by-default disclosure
 * rows, not the page's primary list. */
function ActiveBadge({ count }: { count: number }) {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        background: "var(--color-bg-elevated)",
        border: "1px solid var(--color-border)",
        borderRadius: 999,
        padding: "6px 14px 6px 12px",
        boxShadow: "var(--shadow-sm)",
      }}
    >
      <span style={{ fontSize: TEXT.base, fontWeight: 700 }}>Active</span>
      <span
        style={{
          fontSize: TEXT.xs,
          fontWeight: 700,
          color: "var(--color-text-secondary)",
          background: "var(--color-bg-hover)",
          borderRadius: 999,
          padding: "1px 8px",
        }}
      >
        {count}
      </span>
    </div>
  );
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
  onRename,
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
  onRename: (title: string) => void;
  onArchive: () => void;
  onFork: () => void;
}) {
  const isTerminal = session.type === "terminal";
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  // A chat session can only be forked while it's the one live in the
  // window's single Pi AgentSession — same constraint Sidebar.tsx's
  // canFork applies (see forkChatSession's doc comment in App.tsx). A
  // terminal session has no such constraint.
  const canFork = isTerminal || active;

  const startRename = () => {
    setDraft(sessionTitle(session));
    setRenaming(true);
  };
  const commitRename = () => {
    setRenaming(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== sessionTitle(session)) onRename(trimmed);
  };

  return (
    <div
      className={`metaharn-card-row metaharn-card-row-bordered${active ? " metaharn-card-row-active" : ""}`}
      style={{
        position: "relative",
        borderRadius: RADIUS.md,
        padding: SPACE.sm + 2,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: SPACE.sm }}>
        <span style={{ fontSize: TEXT.xs, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          <StatusLine status={status} fallback="Idle" />
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 10.5, color: "var(--color-text-muted)", flexShrink: 0 }}>
          <ClockIcon size={10} />
          {formatRelativeTime(session.modified)}
        </span>
      </div>

      {renaming ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitRename();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setRenaming(false);
            }
          }}
          onBlur={commitRename}
          style={{
            display: "block",
            width: "100%",
            marginTop: 6,
            padding: "2px 4px",
            fontSize: TEXT.md,
            fontWeight: 600,
            fontFamily: isTerminal ? '"IBM Plex Mono", Menlo, Monaco, monospace' : undefined,
          }}
        />
      ) : (
        <button
          onClick={onSelect}
          onDoubleClick={(e) => {
            e.preventDefault();
            startRename();
          }}
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
      )}

      {!renaming && (
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
          <IconButton
            title="Rename session"
            onClick={startRename}
          >
            <EditIcon size={13} />
          </IconButton>
          {canFork && (
            <IconButton title="Fork this session" onClick={onFork}>
              <ForkIcon size={13} />
            </IconButton>
          )}
          <IconButton title="Archive session" onClick={onArchive}>
            <ArchiveIcon size={13} />
          </IconButton>
        </div>
      )}
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
