import { useEffect, useRef, useState } from "react";
import type {
  AgentInfo,
  AgentKind,
  MetaHarnEvent,
  ProjectListItem,
  SessionDependency,
  SessionListItem,
  SessionStats,
  SessionTreeNode,
  WorktreeLink,
} from "../preload/preload.js";
import Sidebar from "./Sidebar.js";
import TopBar from "./TopBar.js";
import HomePage from "./HomePage.js";
import ProjectOverview from "./ProjectOverview.js";
import ProjectsListPage from "./ProjectsListPage.js";
import FilesPane from "./FilesPane.js";
import TerminalPane from "./TerminalPane.js";
import SettingsPage from "./SettingsPage.js";
import ConfirmDialog from "./ConfirmDialog.js";
import SessionTreeView from "./SessionTreeView.js";
import ContextWindowPanel from "./ContextWindowPanel.js";
import GitPanel from "./GitPanel.js";
import TerminalGrid from "./TerminalGrid.js";
import AgentSwapMenu from "./AgentSwapMenu.js";
import { BranchIcon, ClockIcon, DatabaseIcon, ForkIcon, GridIcon } from "./icons.js";
import { AGENT_DISPLAY_NAMES, formatAge, projectLabel, sessionTitle } from "./format.js";
import { useSettings } from "./SettingsContext.js";
import { renderMarkdown } from "./markdown.js";

interface ChatMessage {
  role: "user" | "assistant" | "tool" | "system" | "thinking";
  text: string;
  // Only set for role "tool" — lets tool_end update the same row tool_start
  // created in place instead of appending a second, uncorrelated one.
  toolCallId?: string;
  status?: "pending" | "done" | "error";
  detail?: string;
}

/** Arbitrary tool args/result (real objects from the Pi SDK, shape varies
 * per tool) reduced to one short, human-scannable line — prefers a common
 * "what this call is about" field (a path, a command, a pattern) over a
 * generic JSON dump, since that's what's actually useful to skim. */
function summarizeToolPayload(payload: unknown): string {
  if (payload == null) return "";
  if (typeof payload === "string") return payload.length > 160 ? `${payload.slice(0, 160)}...` : payload;
  if (typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    for (const key of ["file_path", "path", "command", "pattern", "url", "query"]) {
      if (typeof obj[key] === "string") return obj[key] as string;
    }
    try {
      const s = JSON.stringify(payload);
      return s.length > 160 ? `${s.slice(0, 160)}...` : s;
    } catch {
      return "";
    }
  }
  return String(payload);
}

type MainView =
  | { kind: "home" }
  | { kind: "connect" }
  | { kind: "projectsList" }
  | { kind: "project"; cwd: string; tab: "overview" | "files" }
  | { kind: "session"; cwd: string; sessionPath?: string }
  | { kind: "terminal"; cwd: string; terminalSessionId: string; resume: boolean }
  | { kind: "settings" };

const SIDEBAR_MIN_WIDTH = 180;
const SIDEBAR_STORAGE_KEY = "metaharn:sidebarWidth";
const SIDEBAR_DEFAULT_WIDTH = 220;

export default function App() {
  const { defaultAgentKind } = useSettings();
  const [repoPath, setRepoPath] = useState("");
  const [connectError, setConnectError] = useState<string | undefined>();
  const [view, setView] = useState<MainView>({ kind: "home" });
  const [ready, setReady] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [pendingConfirm, setPendingConfirm] = useState<{
    message: string;
    details?: React.ReactNode;
    onConfirm: () => void;
  } | null>(null);
  const [showTree, setShowTree] = useState(false);
  const [sessionTree, setSessionTree] = useState<SessionTreeNode[]>([]);
  const [showContext, setShowContext] = useState(false);
  const [showGitPanel, setShowGitPanel] = useState(false);
  const [sessionStats, setSessionStats] = useState<SessionStats | null>(null);
  const [appInfo, setAppInfo] = useState<{ modelId: string } | null>(null);
  // Every terminal session currently "open" (tab-strip visible), each with
  // a real, running pty behind it — separate from `view`, which just says
  // which one is the currently-*visible* tab. Staying in this list (not
  // being unmounted) is what keeps a session's process and xterm scrollback
  // alive across switches — see the co-mounted/CSS-toggle render below.
  // `generation` forces a full TerminalPane remount when an agent swap
  // happens in place (same session id, brand-new pty) — see swapTerminalAgent.
  const [openTerminalTabs, setOpenTerminalTabs] = useState<
    { id: string; cwd: string; generation: number; exited: boolean }[]
  >([]);
  const [showAgentSwap, setShowAgentSwap] = useState(false);
  // Set while a swap's handoff-summary generation is in flight (a real CLI
  // round-trip — can take several seconds, unlike the old instant swap) so
  // the trigger button can show a busy state instead of looking unresponsive.
  const [swappingSessionId, setSwappingSessionId] = useState<string | null>(null);
  const [installedAgents, setInstalledAgents] = useState<AgentInfo[]>([{ kind: "claude", displayName: "Claude Code" }]);
  const [sessionDependencies, setSessionDependencies] = useState<SessionDependency[]>([]);
  const [worktreeLinks, setWorktreeLinks] = useState<WorktreeLink[]>([]);
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const raw = localStorage.getItem(SIDEBAR_STORAGE_KEY);
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) ? parsed : SIDEBAR_DEFAULT_WIDTH;
  });
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  // Multi-pane terminal grid — an additional way to view a SUBSET of the
  // already-open tabs simultaneously, not a replacement for the single-tab
  // view. `gridSessionIds` is filtered against `openTerminalTabs` at render
  // time (a session can close while the grid is showing it); no separate
  // cleanup needed here for that. Column sizes are TerminalGrid's own
  // internal concern, not lifted here — nothing else in the app needs them.
  const [showTerminalGrid, setShowTerminalGrid] = useState(false);
  const [gridSessionIds, setGridSessionIds] = useState<string[]>([]);
  const [gridCols, setGridCols] = useState(2);

  // The grid's own toggle button only lives in the terminal view's toolbar,
  // but showTerminalGrid itself is plain top-level state with no built-in
  // tie to which view is current — navigating to Overview/Files/a different
  // project left it true, and since <TerminalGrid> used to render whenever
  // showTerminalGrid was true (no view.kind check), the whole live-terminals
  // grid kept rendering stacked underneath whatever page you navigated to.
  // That's what actually produced a cluttered-looking Overview page: an
  // unrelated feature bleeding into it, not just this page's own density.
  useEffect(() => {
    if (view.kind !== "terminal" && showTerminalGrid) setShowTerminalGrid(false);
  }, [view.kind, showTerminalGrid]);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  // Global listeners only while an actual drag is in progress — the handle
  // itself just flips isResizingSidebar on mousedown; width tracks the
  // cursor's real X position (the sidebar's own left edge is always 0, so
  // clientX doubles directly as "distance from the left edge" with no
  // extra offset math needed).
  useEffect(() => {
    if (!isResizingSidebar) return;
    const onMouseMove = (e: MouseEvent) => {
      setSidebarWidth(Math.min(window.innerWidth * 0.2, Math.max(SIDEBAR_MIN_WIDTH, e.clientX)));
    };
    const onMouseUp = () => setIsResizingSidebar(false);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [isResizingSidebar]);
  // Renderer-side-only terminal liveness heuristic (see 08-known-limitations.md's
  // note on why this can't be a true 3-state signal): every metaharnPty.onData
  // event, terminal-session-scoped, is a real "this session just produced
  // output" fact — recorded into a ref (not state, since output floods
  // constantly and re-rendering on every byte would be wasteful) and turned
  // into a small "active" id set by a ticking interval below, only while at
  // least one terminal tab is open.
  const terminalActivityRef = useRef<Map<string, number>>(new Map());
  const [activeTerminalIds, setActiveTerminalIds] = useState<Set<string>>(new Set());
  const TERMINAL_ACTIVE_WINDOW_MS = 2000;
  // Bridges a worktree chat session's creation (fire-and-forget metaharn.init)
  // to recording its dependency edge — the new session's real id is only
  // known once its "ready" event arrives, not at creation time (see the
  // "ready" case in the onEvent subscription below).
  const pendingWorktreeParentRef = useRef<string | null>(null);
  const readyRef = useRef(ready);
  readyRef.current = ready;
  const viewRef = useRef(view);
  viewRef.current = view;
  // Auto-scroll the chat transcript as messages/deltas arrive — but only
  // while the user was already reading near the bottom, so scrolling back
  // up to review earlier turns doesn't get yanked back down mid-stream.
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const handleMessagesScroll = () => {
    const el = messagesContainerRef.current;
    if (!el) return;
    isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  useEffect(() => {
    // An empty transcript means a session was just switched/opened fresh
    // (every such call site does setMessages([]) first) — always start a
    // new session following the bottom, regardless of whether scrolling up
    // in a PREVIOUS session had left this ref false.
    if (messages.length === 0) isNearBottomRef.current = true;
    const el = messagesContainerRef.current;
    if (el && isNearBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);
  // The underlying Pi agent session in the main process stays alive when the
  // renderer navigates away to Overview/Files/the projects list — only
  // opening a *different* session (or none yet) actually disposes it, so
  // navigating back to an already-open session/terminal needs no re-fetch:
  // `messages`/`ready`/`openTerminalTabs` still hold their state since
  // nothing resets them on a plain nav.

  const refreshSessions = () => {
    void window.metaharn.listSessions().then(setSessions);
  };
  const refreshProjects = () => {
    void window.metaharn.listProjects().then(setProjects);
  };
  const refreshDependencies = () => {
    void window.metaharn.getSessionDependencies().then(setSessionDependencies);
  };
  const refreshWorktreeLinks = () => {
    void window.metaharn.getWorktreeLinks().then(setWorktreeLinks);
  };

  useEffect(() => {
    refreshSessions();
    refreshProjects();
    refreshDependencies();
    refreshWorktreeLinks();
    void window.metaharn.getAppInfo().then(({ modelId }) => setAppInfo({ modelId }));
    void window.metaharn.listAvailableAgents().then((agents) => {
      if (agents.length > 0) setInstalledAgents(agents);
    });
  }, []);

  // Global (not per-TerminalPane) pty-output listener — every ptyData event
  // broadcasts to every renderer-side subscriber, so this runs alongside
  // each open TerminalPane's own onData subscription without interfering
  // with it. Only records timestamps; never triggers a re-render itself.
  useEffect(() => {
    const unsubscribe = window.metaharnPty.onData(({ terminalSessionId, data }) => {
      if (data.length === 0) return;
      terminalActivityRef.current.set(terminalSessionId, Date.now());
    });
    return unsubscribe;
  }, []);

  // Re-derives the "active" id set from the raw timestamp ref on a light
  // tick — only while a terminal tab is actually open, so an idle app with
  // no terminals running does no polling at all. setState is skipped when
  // the computed set is unchanged, so this doesn't cause a re-render every
  // second once sessions have settled into Idle.
  useEffect(() => {
    if (openTerminalTabs.length === 0) {
      if (activeTerminalIds.size > 0) setActiveTerminalIds(new Set());
      return;
    }
    const tick = () => {
      const now = Date.now();
      const next = new Set<string>();
      for (const [id, lastAt] of terminalActivityRef.current) {
        if (now - lastAt < TERMINAL_ACTIVE_WINDOW_MS) next.add(id);
      }
      setActiveTerminalIds((prev) => {
        if (prev.size === next.size && [...prev].every((id) => next.has(id))) return prev;
        return next;
      });
    };
    tick();
    const interval = setInterval(tick, 500);
    return () => clearInterval(interval);
  }, [openTerminalTabs.length]);

  /** Adds a terminal session to the open-tabs set if it isn't there
   * already (dedupe by id) — every place that opens a terminal session
   * calls this alongside setView so its TerminalPane stays mounted once
   * opened, not just for the current navigation. */
  const openTerminalTab = (id: string, cwd: string) => {
    setOpenTerminalTabs((prev) =>
      prev.some((t) => t.id === id) ? prev : [...prev, { id, cwd, generation: 0, exited: false }],
    );
  };

  /** Reported by TerminalPane the moment its underlying pty process exits —
   * including while that tab is hidden/inactive, since TerminalPane stays
   * mounted for a tab's whole open lifetime regardless of which one is
   * currently visible. Without this, a dead background terminal looked
   * identical to a live one in the tab strip; the only way to tell was to
   * click in and read the scrollback yourself. */
  const markTerminalExited = (id: string) => {
    setOpenTerminalTabs((prev) => prev.map((t) => (t.id === id ? { ...t, exited: true } : t)));
  };

  /** Swaps which real CLI agent an existing terminal session runs, via the
   * header's `{agent} ⌄` dropdown. The outgoing agent gets
   * one chance to summarize itself first (see agents/handoff.ts) so the new
   * one starts primed with what happened, rather than a blank prompt — but
   * that's best-effort: no native way exists to hand off a live session
   * between different CLI products, so a summary is the closest thing to
   * "seamless" that's actually possible. The DB row and tab identity
   * (title, position) stay the same either way. */
  const swapTerminalAgent = (session: SessionListItem, agentKind: AgentInfo["kind"]) => {
    setPendingConfirm({
      message: `Swap this terminal to ${agentKind}? I'll try to carry over context from the current conversation — if that's not possible it'll start fresh.`,
      onConfirm: () => {
        setPendingConfirm(null);
        setSwappingSessionId(session.id);
        window.metaharn
          .swapTerminalSessionAgent(session.id, session.cwd, agentKind)
          .then(() => {
            setOpenTerminalTabs((prev) =>
              prev.map((t) => (t.id === session.id ? { ...t, generation: t.generation + 1, exited: false } : t)),
            );
            refreshSessions();
          })
          .catch((err: Error) => alert(`Couldn't swap agent: ${err.message}`))
          .finally(() => setSwappingSessionId(null));
      },
    });
  };

  /** Explicit close (tab-strip ×) — kills the real pty, distinct from just
   * navigating away, which must never kill anything. */
  const closeTerminalTab = (id: string) => {
    void window.metaharnPty.close(id);
    setOpenTerminalTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      const current = viewRef.current;
      if (current.kind === "terminal" && current.terminalSessionId === id) {
        const fallback = next[next.length - 1];
        setView(
          fallback
            ? { kind: "terminal", cwd: fallback.cwd, terminalSessionId: fallback.id, resume: true }
            : { kind: "project", cwd: current.cwd, tab: "overview" },
        );
      }
      return next;
    });
  };

  const appendToLastAssistant = (delta: string) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.role === "assistant") {
        return [...prev.slice(0, -1), { ...last, text: last.text + delta }];
      }
      return [...prev, { role: "assistant", text: delta }];
    });
  };

  const appendToLastThinking = (delta: string) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.role === "thinking") {
        return [...prev.slice(0, -1), { ...last, text: last.text + delta }];
      }
      return [...prev, { role: "thinking", text: delta }];
    });
  };

  const refreshSessionStats = () => {
    // viewRef, not view — this is called from the onEvent subscription
    // below, which is set up once in a []-dep effect and would otherwise
    // close over whatever `view` was at mount time.
    const current = viewRef.current;
    if (current.kind === "terminal") {
      void window.metaharn.getTerminalSessionStats(current.cwd, current.terminalSessionId).then(setSessionStats);
    } else {
      void window.metaharn.getSessionStats().then(setSessionStats);
    }
  };

  useEffect(() => {
    const unsubscribe = window.metaharn.onEvent((data: MetaHarnEvent) => {
      switch (data.type) {
        case "ready":
          setMessages(data.history);
          setReady(true);
          refreshSessions();
          refreshSessionStats();
          if (pendingWorktreeParentRef.current) {
            const parentId = pendingWorktreeParentRef.current;
            pendingWorktreeParentRef.current = null;
            void window.metaharn.setSessionDependency(data.sessionId, parentId).then(refreshDependencies);
          }
          break;
        case "text_delta":
          appendToLastAssistant(data.delta);
          break;
        case "thinking_delta":
          appendToLastThinking(data.delta);
          break;
        case "tool_start":
          setMessages((prev) => [
            ...prev,
            {
              role: "tool",
              text: data.toolName,
              toolCallId: data.toolCallId,
              status: "pending",
              detail: summarizeToolPayload(data.args),
            },
          ]);
          break;
        case "tool_end":
          setMessages((prev) => {
            const idx = prev.findIndex((m) => m.role === "tool" && m.toolCallId === data.toolCallId);
            const updated: ChatMessage = {
              role: "tool",
              text: data.toolName,
              toolCallId: data.toolCallId,
              status: data.isError ? "error" : "done",
              detail: summarizeToolPayload(data.result),
            };
            // No matching tool_start row (shouldn't normally happen) — don't
            // silently drop the event, just append instead of updating in place.
            if (idx === -1) return [...prev, updated];
            return [...prev.slice(0, idx), updated, ...prev.slice(idx + 1)];
          });
          break;
        case "agent_end":
          setStreaming(false);
          // Pi doesn't write a session's JSONL file until an assistant
          // response actually completes (avoids littering disk with
          // never-used sessions) — so a brand-new session only becomes
          // visible to SessionManager.listAll() after this point, not at
          // "ready". Refresh here so the sidebar picks it up promptly.
          refreshSessions();
          // Context usage only changes as a result of a completed turn.
          refreshSessionStats();
          break;
        case "error":
          setMessages((prev) => [...prev, { role: "system", text: `Error: ${data.message}` }]);
          setStreaming(false);
          // An error before the session ever became ready (e.g. a bad repo
          // path) means init failed — fall back to wherever makes sense.
          if (!readyRef.current) {
            const current = viewRef.current;
            setView(
              current.kind === "session" ? { kind: "project", cwd: current.cwd, tab: "overview" } : { kind: "connect" },
            );
          }
          break;
      }
    });
    return unsubscribe;
  }, []);

  // "Creating a session" lands you on the project's Overview (terminal
  // ready to use immediately) — it does NOT start an agent chat. Chat is
  // opt-in via "+ New chat" inside Overview, or resuming a past one.
  const connect = () => {
    if (!repoPath.trim()) return;
    const cwd = repoPath.trim();
    setConnectError(undefined);
    window.metaharn
      .registerProject(cwd)
      .then(() => {
        refreshProjects();
        setRepoPath("");
        setView({ kind: "project", cwd, tab: "overview" });
      })
      .catch((err: Error) => setConnectError(err.message));
  };

  const openSession = (session: SessionListItem) => {
    if (session.type === "terminal") {
      // Reopening an existing terminal session — resume it, don't retitle
      // it, unlike a brand-new one. If it's already open in another tab,
      // openTerminalTab is a no-op and this just switches to it.
      openTerminalTab(session.id, session.cwd);
      setView({ kind: "terminal", cwd: session.cwd, terminalSessionId: session.id, resume: true });
      return;
    }
    setReady(false);
    setMessages([]);
    setView({ kind: "session", cwd: session.cwd, sessionPath: session.path });
    void window.metaharn.init(session.cwd, session.path);
  };

  const newChatSession = (cwd: string) => {
    setReady(false);
    setMessages([]);
    setView({ kind: "session", cwd });
    void window.metaharn.init(cwd);
  };

  const newTerminalSession = (cwd: string, agentKind: AgentKind) => {
    void window.metaharn.createTerminalSession(cwd, agentKind).then(({ id }) => {
      // "New" means new — a fresh session, not a resume.
      openTerminalTab(id, cwd);
      setView({ kind: "terminal", cwd, terminalSessionId: id, resume: false });
      refreshSessions();
    });
  };

  /** One-click terminal launch from Sidebar.tsx's per-project ›_ button — uses the
   * user's default agent (Settings → Agent CLIs) if it's installed, else
   * whichever agent is, silently, rather than popping the full picker
   * ProjectOverview's "+ New terminal session" shows (too little room for
   * that in a narrow sidebar row) — deliberate/full agent choice is still
   * one click away on the project's own Overview page. */
  const quickOpenTerminal = (cwd: string) => {
    const agentKind = installedAgents.find((a) => a.kind === defaultAgentKind)?.kind ?? installedAgents[0]?.kind;
    if (!agentKind) return;
    newTerminalSession(cwd, agentKind);
  };

  /** HomePage.tsx's launcher — same agent-resolution fallback as
   * quickOpenTerminal, plus the typed goal seeded through as the new
   * session's real initial prompt (see ipc.ts's metaharn:createTerminalSession). */
  const startFromHome = (project: ProjectListItem, prompt: string) => {
    const agentKind = installedAgents.find((a) => a.kind === defaultAgentKind)?.kind ?? installedAgents[0]?.kind;
    if (!agentKind) return;
    window.metaharn.createTerminalSession(project.localPath, agentKind, prompt).then(({ id }) => {
      openTerminalTab(id, project.localPath);
      setView({ kind: "terminal", cwd: project.localPath, terminalSessionId: id, resume: false });
      refreshSessions();
    });
  };

  /** ProjectOverview.tsx's own project-scoped quick-start box — same
   * seeded-launch mechanism as startFromHome, just bound to a cwd it
   * already knows instead of a picked project. */
  const quickStart = (cwd: string, prompt: string) => {
    const agentKind = installedAgents.find((a) => a.kind === defaultAgentKind)?.kind ?? installedAgents[0]?.kind;
    if (!agentKind) return;
    window.metaharn.createTerminalSession(cwd, agentKind, prompt).then(({ id }) => {
      openTerminalTab(id, cwd);
      setView({ kind: "terminal", cwd, terminalSessionId: id, resume: false });
      refreshSessions();
    });
  };

  /** ProjectOverview.tsx's WORKTREES "+ New" card — same real `git worktree`
   * mechanism as createWorktreeSession below, entered from the project
   * itself rather than from an existing session (no parent session id
   * needed since cwd is already known). Always opens a plain terminal
   * session in the new checkout, no seed prompt — matches the existing
   * "+ New terminal session" quick-launch's plainness. */
  const createWorktreeFromProject = (cwd: string) => {
    const agentKind = installedAgents.find((a) => a.kind === defaultAgentKind)?.kind ?? installedAgents[0]?.kind;
    if (!agentKind) return;
    window.metaharn
      .createWorktreeFromProject(cwd)
      .then(({ worktreePath }) => {
        refreshProjects();
        refreshWorktreeLinks();
        void window.metaharn.createTerminalSession(worktreePath, agentKind).then(({ id }) => {
          openTerminalTab(id, worktreePath);
          setView({ kind: "terminal", cwd: worktreePath, terminalSessionId: id, resume: false });
          refreshSessions();
        });
      })
      .catch((err: Error) => alert(`Couldn't create worktree: ${err.message}`));
  };

  /**
   * Permanently removes a worktree — the real `git worktree` checkout, its
   * branch, and its catalog rows (see ipc.ts's metaharn:removeWorktreeSession).
   * Always reviews real uncommitted changes first (metaharnFiles.getGitChanges)
   * so the confirmation dialog can show exactly what's about to be lost,
   * not just a bare yes/no — the actual removal is forced (--force) once
   * confirmed, so this review step is the only safety net, not git's own
   * dirty-worktree refusal.
   */
  const removeWorktree = (worktree: { cwd: string; branch: string }) => {
    void window.metaharnFiles.getGitChanges(worktree.cwd).then((changes) => {
      const dirty = changes && changes.length > 0;
      setPendingConfirm({
        message: `Permanently remove the worktree at ${worktree.cwd} (branch ${worktree.branch})? This deletes the real git worktree and cannot be undone.`,
        details: dirty ? (
          <div>
            <div style={{ fontSize: 12.5, color: "var(--color-error)", marginBottom: 6 }}>
              {changes!.length} uncommitted change{changes!.length === 1 ? "" : "s"} will be lost:
            </div>
            <div
              style={{
                maxHeight: 160,
                overflowY: "auto",
                border: "1px solid var(--color-border)",
                borderRadius: 6,
                padding: "6px 10px",
                fontFamily: '"IBM Plex Mono", Menlo, Monaco, monospace',
                fontSize: 12,
              }}
            >
              {changes!.map((c) => (
                <div key={c.path} style={{ display: "flex", gap: 8, padding: "2px 0" }}>
                  <span style={{ color: "var(--color-text-muted)", width: 62, flexShrink: 0 }}>{c.status}</span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.path}</span>
                </div>
              ))}
            </div>
          </div>
        ) : undefined,
        onConfirm: () => {
          setPendingConfirm(null);
          window.metaharn
            .removeWorktreeSession(worktree.cwd)
            .then(() => {
              refreshProjects();
              refreshSessions();
              refreshWorktreeLinks();
              setOpenTerminalTabs((prev) => {
                const [forThisWorktree, rest] = [
                  prev.filter((t) => t.cwd === worktree.cwd),
                  prev.filter((t) => t.cwd !== worktree.cwd),
                ];
                forThisWorktree.forEach((t) => void window.metaharnPty.close(t.id));
                return rest;
              });
              const current = viewRef.current;
              if (
                (current.kind === "project" || current.kind === "session" || current.kind === "terminal") &&
                current.cwd === worktree.cwd
              ) {
                setView({ kind: "projectsList" });
              }
            })
            .catch((err: Error) => alert(`Couldn't remove worktree: ${err.message}`));
        },
      });
    });
  };

  const titleTerminalSession = (id: string, firstLine: string) => {
    const title = firstLine.length > 60 ? `${firstLine.slice(0, 60)}...` : firstLine;
    void window.metaharn.renameTerminalSession(id, title).then(refreshSessions);
  };

  const forkTerminalSession = (session: SessionListItem) => {
    window.metaharn
      .forkTerminalSession(session.cwd, session.id, session.name)
      .then(({ id, hasHistory, reason }) => {
        if (!hasHistory || !id) {
          alert(reason ?? "Nothing to fork yet — send a message in this terminal first.");
          return;
        }
        // The fork already has real history the moment it's created — open
        // it as a resume, not a fresh start.
        openTerminalTab(id, session.cwd);
        setView({ kind: "terminal", cwd: session.cwd, terminalSessionId: id, resume: true });
        refreshSessions();
      })
      .catch((err: Error) => alert(`Couldn't fork session: ${err.message}`));
  };

  const selectProject = (cwd: string) => setView({ kind: "project", cwd, tab: "overview" });
  const newProject = () => {
    setRepoPath("");
    setConnectError(undefined);
    setView({ kind: "connect" });
  };
  const importProject = () => {
    void window.metaharn.pickDirectory().then((cwd) => {
      if (!cwd) return;
      window.metaharn
        .registerProject(cwd)
        .then(() => {
          refreshProjects();
          setView({ kind: "project", cwd, tab: "overview" });
        })
        .catch((err: Error) => alert(err.message));
    });
  };
  const backToProject = (cwd: string) => setView({ kind: "project", cwd, tab: "overview" });
  const backToProjectsList = () => setView({ kind: "projectsList" });

  // The sidebar is a single persistent component now (Sidebar.tsx) — there's
  // no more TopBar tab toggle to swap it, and nothing left that redirects
  // the main view as a side effect of a sidebar interaction (that used to
  // mean a "Projects" tab didn't always show the projects list, and could
  // leave the sidebar and main content visibly disagreeing about where you
  // are). The brand mark now goes to HomePage (goHome) instead — clicking a
  // logo meaning "go home" is the more universal convention, and HomePage
  // itself offers "View all projects" for this destination. goToProjectsList
  // stays as the actual full-browse-page navigation, used by both that link
  // and Sidebar's own "Browse all projects" one.
  const goHome = () => setView({ kind: "home" });
  const goToProjectsList = () => setView({ kind: "projectsList" });

  const deleteSession = (session: SessionListItem) => {
    const isTerminal = session.type === "terminal";
    setPendingConfirm({
      message: isTerminal ? "Delete this terminal session?" : "Delete this session? It'll be moved to the trash.",
      onConfirm: () => {
        setPendingConfirm(null);
        const request = isTerminal
          ? window.metaharn.deleteTerminalSession(session.id)
          : window.metaharn.deleteSession(session.path);
        request
          .then(() => {
            refreshSessions();
            if (isTerminal) {
              void window.metaharnPty.close(session.id);
              setOpenTerminalTabs((prev) => prev.filter((t) => t.id !== session.id));
            }
            const current = viewRef.current;
            const isActive = isTerminal
              ? current.kind === "terminal" && current.terminalSessionId === session.id
              : current.kind === "session" && current.sessionPath === session.path;
            if (isActive) setView({ kind: "project", cwd: session.cwd, tab: "overview" });
          })
          .catch((err: Error) => alert(`Couldn't delete session: ${err.message}`));
      },
    });
  };

  /**
   * Reversible, unlike deleteSession above — never touches the real JSONL
   * file or a live pty, purely a visibility flag (see catalog.ts's
   * archiveSession doc comment). No confirmation needed for exactly that
   * reason. Archiving the session currently being viewed has the same
   * "now what's shown" question deleting it does, so it gets the same
   * navigate-away-to-Overview answer.
   */
  const archiveSession = (session: SessionListItem) => {
    const isTerminal = session.type === "terminal";
    void window.metaharn.archiveSession(session.id).then(() => {
      refreshSessions();
      const current = viewRef.current;
      const isActive = isTerminal
        ? current.kind === "terminal" && current.terminalSessionId === session.id
        : current.kind === "session" && current.sessionPath === session.path;
      if (isActive) setView({ kind: "project", cwd: session.cwd, tab: "overview" });
    });
  };

  /** Un-archives, then opens it the normal way — a single click from
   * ProjectOverview.tsx's "ARCHIVED SESSIONS" section's Resume button,
   * rather than "unarchive, then separately go find it in the normal
   * list." */
  const resumeArchivedSession = (session: SessionListItem) => {
    void window.metaharn.unarchiveSession(session.id).then(() => {
      refreshSessions();
      openSession(session);
    });
  };

  /**
   * Permanently removes a project — real, not just catalog rows: any
   * `git worktree` checkouts hanging off it get actually removed from disk
   * too (see ipc.ts's metaharn:removeProject), so this always reviews the
   * real damage first (metaharn.getProjectDeletionPreview) rather than the
   * old bare "nothing on disk is touched" message, which stopped being
   * true the moment worktrees existed. The project's own folder itself is
   * never touched either way — only its linked worktrees are separate
   * real directories.
   */
  const removeProject = (project: ProjectListItem) => {
    void window.metaharn.getProjectDeletionPreview(project.id).then((preview) => {
      const hasWorktrees = preview.worktrees.length > 0;
      setPendingConfirm({
        message: `Remove "${project.name}" from MetaHarn? This cannot be undone.`,
        details:
          preview.sessionCount > 0 || hasWorktrees ? (
            <div>
              <div style={{ fontSize: 12.5, color: "var(--color-error)", marginBottom: hasWorktrees ? 6 : 0 }}>
                This deletes {preview.sessionCount} session{preview.sessionCount === 1 ? "" : "s"}
                {hasWorktrees
                  ? ` and ${preview.worktrees.length} real git worktree${preview.worktrees.length === 1 ? "" : "s"} on disk`
                  : ""}
                .
              </div>
              {hasWorktrees && (
                <div
                  style={{
                    maxHeight: 160,
                    overflowY: "auto",
                    border: "1px solid var(--color-border)",
                    borderRadius: 6,
                    padding: "6px 10px",
                    fontFamily: '"IBM Plex Mono", Menlo, Monaco, monospace',
                    fontSize: 12,
                  }}
                >
                  {preview.worktrees.map((w) => (
                    <div key={w.cwd} style={{ display: "flex", gap: 8, padding: "2px 0" }}>
                      <span style={{ color: "var(--color-text-muted)", flexShrink: 0 }}>{w.branch}</span>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{w.cwd}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : undefined,
        onConfirm: () => {
          setPendingConfirm(null);
          window.metaharn
            .removeProject(project.id)
            .then(() => {
              refreshProjects();
              refreshSessions();
              refreshWorktreeLinks();
              // Close (not just hide) any open terminal tabs for this
              // project OR any of its now-deleted worktrees — their
              // catalog rows are gone along with it.
              const worktreeCwds = new Set(preview.worktrees.map((w) => w.cwd));
              setOpenTerminalTabs((prev) => {
                const [gone, rest] = [
                  prev.filter((t) => t.cwd === project.localPath || worktreeCwds.has(t.cwd)),
                  prev.filter((t) => t.cwd !== project.localPath && !worktreeCwds.has(t.cwd)),
                ];
                gone.forEach((t) => void window.metaharnPty.close(t.id));
                return rest;
              });
              const current = viewRef.current;
              if (
                (current.kind === "project" || current.kind === "session" || current.kind === "terminal") &&
                (current.cwd === project.localPath || worktreeCwds.has(current.cwd))
              ) {
                setView({ kind: "projectsList" });
              }
            })
            .catch((err: Error) => alert(`Couldn't remove project: ${err.message}`));
        },
      });
    });
  };

  const archiveProject = (project: ProjectListItem) => {
    window.metaharn
      .archiveProject(project.id)
      .then(refreshProjects)
      .catch((err: Error) => alert(`Couldn't archive project: ${err.message}`));
  };

  const unarchiveProject = (project: ProjectListItem) => {
    window.metaharn
      .unarchiveProject(project.id)
      .then(refreshProjects)
      .catch((err: Error) => alert(`Couldn't unarchive project: ${err.message}`));
  };

  const sendPrompt = () => {
    if (!input.trim() || !ready || streaming) return;
    setMessages((prev) => [...prev, { role: "user", text: input.trim() }]);
    void window.metaharn.prompt(input.trim());
    setInput("");
    setStreaming(true);
  };

  const stopStreaming = () => {
    void window.metaharn.abort();
  };

  const toggleTree = () => {
    if (showTree) {
      setShowTree(false);
      return;
    }
    setShowContext(false);
    setShowGitPanel(false);
    setShowTerminalGrid(false);
    void window.metaharn.getSessionTree().then((tree) => {
      setSessionTree(tree);
      setShowTree(true);
    });
  };

  const branchTo = (entryId: string) => {
    setShowTree(false);
    // Same "clear then wait for the pushed ready event" shape as
    // openSession/quickSession — branchSession's IPC handler re-sends a
    // fresh `ready` event with the new leaf's history once navigateTree
    // resolves.
    setReady(false);
    setMessages([]);
    void window.metaharn.branchSession(entryId);
  };

  const toggleContext = () => {
    if (showContext) {
      setShowContext(false);
      return;
    }
    setShowTree(false);
    setShowAgentSwap(false);
    setShowGitPanel(false);
    setShowTerminalGrid(false);
    refreshSessionStats();
    setShowContext(true);
  };

  const toggleGitPanel = () => {
    if (showGitPanel) {
      setShowGitPanel(false);
      return;
    }
    setShowTree(false);
    setShowContext(false);
    setShowAgentSwap(false);
    setShowTerminalGrid(false);
    setShowGitPanel(true);
  };

  /** Multi-pane grid — a real, additional view mode for terminal sessions
   * only (no chat-session equivalent, see 08-known-limitations.md's note on
   * chat sessions being one-per-window). Closes the other per-session
   * panels on open since they're ambiguous with more than one session
   * visible at once; they close it back on their own open, above. */
  const toggleTerminalGrid = () => {
    if (showTerminalGrid) {
      setShowTerminalGrid(false);
      return;
    }
    setShowTree(false);
    setShowContext(false);
    setShowAgentSwap(false);
    setShowGitPanel(false);
    setShowTerminalGrid(true);
  };

  const addAllToGrid = () => {
    const MAX_GRID_SESSIONS = 9;
    const ids = openTerminalTabs.map((t) => t.id).slice(0, MAX_GRID_SESSIONS);
    setGridSessionIds(ids);
  };

  const emptyGrid = () => setGridSessionIds([]);

  const removeFromGrid = (id: string) => setGridSessionIds((prev) => prev.filter((x) => x !== id));

  /** Swaps two cells' contents in place — a full free-form tiling rearrange
   * isn't necessary for this, swapping on drop is what most simple grid
   * tools do. */
  const reorderGrid = (fromId: string, toId: string) => {
    setGridSessionIds((prev) => {
      const next = [...prev];
      const fromIdx = next.indexOf(fromId);
      const toIdx = next.indexOf(toId);
      if (fromIdx === -1 || toIdx === -1) return prev;
      [next[fromIdx], next[toIdx]] = [next[toIdx], next[fromIdx]];
      return next;
    });
  };

  const forkChatSession = (cwd: string) => {
    window.metaharn
      .forkChatSession()
      .then((result) => {
        if (!result) {
          alert("Nothing to fork yet — send a message first.");
          return;
        }
        setReady(false);
        setMessages([]);
        setView({ kind: "session", cwd, sessionPath: result.path });
        void window.metaharn.init(cwd, result.path);
      })
      .catch((err: Error) => alert(`Couldn't fork session: ${err.message}`));
  };

  /**
   * Real `git worktree` child session — see main/worktree.ts. Distinct from
   * forkTerminalSession/forkChatSession above: a fork copies *history* into
   * a new session in the SAME checkout; this creates a second, independent
   * checkout on disk with its own branch, then a brand-new (unrelated
   * history) session rooted there. Always records a dependency edge back to
   * the parent (Part 3) — a worktree child is inherently "this session's
   * work relates to its parent's," the same relationship "Set dependency"
   * lets you draw manually between any two unrelated sessions.
   */
  const createWorktreeSession = (parentSession: SessionListItem) => {
    window.metaharn
      .createWorktreeSession(parentSession.id)
      .then(({ worktreePath, parentType, parentAgentKind }) => {
        refreshProjects();
        refreshWorktreeLinks();
        if (parentType === "terminal") {
          void window.metaharn.createTerminalSession(worktreePath, parentAgentKind).then(({ id }) => {
            openTerminalTab(id, worktreePath);
            setView({ kind: "terminal", cwd: worktreePath, terminalSessionId: id, resume: false });
            refreshSessions();
            void window.metaharn.setSessionDependency(id, parentSession.id).then(refreshDependencies);
          });
        } else {
          // Chat session ids are only known once Pi's own "ready" event
          // reports one — the onEvent handler above completes this by
          // reading pendingWorktreeParentRef once that arrives.
          pendingWorktreeParentRef.current = parentSession.id;
          setReady(false);
          setMessages([]);
          setView({ kind: "session", cwd: worktreePath });
          void window.metaharn.init(worktreePath);
        }
      })
      .catch((err: Error) => alert(`Couldn't create worktree session: ${err.message}`));
  };

  /** "Set dependency" — a visual-only minimap annotation, never a git
   * operation (see schema.ts's sessionDependencies doc comment). */
  const setDependency = (session: SessionListItem, dependsOn: SessionListItem) => {
    void window.metaharn.setSessionDependency(session.id, dependsOn.id).then(refreshDependencies);
  };
  const removeDependency = (dep: SessionDependency) => {
    void window.metaharn.removeSessionDependency(dep.sessionId, dep.dependsOnSessionId).then(refreshDependencies);
  };

  // Resizable left sidebar — width persists across restarts (same
  // localStorage pattern SettingsContext.tsx already uses for other
  // preferences), clamped between a fixed usable minimum and 20% of the
  // CURRENT window width, recomputed at render time rather than baked into
  // the stored value — so shrinking the window can never leave the sidebar
  // eating an unreasonable share of it, without needing a separate resize
  // listener just to re-clamp the stored number.
  const sidebarMaxWidth = window.innerWidth * 0.2;
  const clampedSidebarWidth = Math.min(sidebarMaxWidth, Math.max(SIDEBAR_MIN_WIDTH, sidebarWidth));

  const activeSessionPath =
    view.kind === "session" ? view.sessionPath : view.kind === "terminal" ? view.terminalSessionId : undefined;
  const activeCwd =
    view.kind === "project" || view.kind === "session" || view.kind === "terminal" ? view.cwd : undefined;
  const currentTerminalSession =
    view.kind === "terminal" ? sessions.find((s) => s.id === view.terminalSessionId) : undefined;
  const currentChatSession =
    view.kind === "session" && view.sessionPath ? sessions.find((s) => s.path === view.sessionPath) : undefined;

  // ContextWindowPanel.tsx previously only refreshed on a chat session's
  // "ready" event or toggleContext() (opening the panel) — switching
  // between two already-open terminal sessions fires neither (terminal
  // sessions have no "ready" event at all), so the panel kept showing the
  // PREVIOUS session's stats until closed and reopened. Clearing +
  // refetching on every session switch fixes that regardless of whether
  // the panel happens to be open when the switch happens.
  useEffect(() => {
    setSessionStats(null);
    refreshSessionStats();
  }, [activeSessionPath]);

  /**
   * Per-session live status, keyed by `session.path` (unique for both types
   * — for terminal rows `path === id`, see sessions.ts). Deliberately not
   * memoized: `sessions`/`openTerminalTabs`/`activeTerminalIds` are all
   * small, v0-scale lists, same lightweight-recompute approach as
   * activeSessionPath/activeCwd just above. Only a session with a REAL live
   * signal gets an entry at all — see Sidebar.tsx's status-dot rendering,
   * which shows nothing (not a guessed "idle") for anything absent here.
   */
  const sessionStatuses = new Map<string, "working" | "waiting" | "active" | "idle" | "exited">();
  if (currentChatSession && (ready || streaming)) {
    sessionStatuses.set(currentChatSession.path, streaming ? "working" : "waiting");
  }
  for (const tab of openTerminalTabs) {
    const session = sessions.find((s) => s.id === tab.id);
    if (!session) continue;
    sessionStatuses.set(session.path, tab.exited ? "exited" : activeTerminalIds.has(tab.id) ? "active" : "idle");
  }

  /** Fork works differently per type at the IPC layer (see forkChatSession's
   * doc comment on the "currently open window session only" constraint) —
   * one dispatcher so Sidebar's hover action doesn't need to know that. */
  const forkSession = (session: SessionListItem) => {
    if (session.type === "terminal") forkTerminalSession(session);
    else forkChatSession(session.cwd);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", width: "100vw", overflow: "hidden" }}>
      <TopBar
        onBrandClick={goHome}
        onNewProject={newProject}
        onOpenSettings={() => setView({ kind: "settings" })}
        settingsActive={view.kind === "settings"}
      />

      <div style={{ display: "flex", flex: 1, minHeight: 0, overflow: "hidden" }}>
        <aside
          style={{
            width: clampedSidebarWidth,
            flexShrink: 0,
            borderRight: "1px solid var(--color-border)",
            background: "var(--color-bg-secondary)",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <Sidebar
            projects={projects}
            sessions={sessions}
            activeCwd={activeCwd}
            activeSessionPath={activeSessionPath}
            sessionStatuses={sessionStatuses}
            dependencies={sessionDependencies}
            worktreeLinks={worktreeLinks}
            onSelectProject={selectProject}
            onOpenTerminal={quickOpenTerminal}
            onShowAllProjects={goToProjectsList}
            onSelectSession={openSession}
            onArchiveSession={archiveSession}
            onForkSession={forkSession}
            onCreateWorktreeSession={createWorktreeSession}
            onSetDependency={setDependency}
            onRemoveDependency={removeDependency}
          />
        </aside>

        <div
          onMouseDown={(e) => {
            e.preventDefault();
            setIsResizingSidebar(true);
          }}
          className="metaharn-resize-handle metaharn-tooltip"
          aria-label="Drag to resize"
          style={{
            width: 5,
            flexShrink: 0,
            cursor: "col-resize",
            background: isResizingSidebar ? "var(--color-accent)" : "transparent",
          }}
        />

      <main
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          padding: 24,
          overflow: "hidden",
        }}
      >
        {view.kind === "home" && (
          <HomePage
            projects={projects}
            sessions={sessions}
            onStart={startFromHome}
            onShowAllProjects={goToProjectsList}
            onImportProject={importProject}
          />
        )}

        {view.kind === "connect" && (
          <>
            <h1 style={{ marginTop: 0 }}>MetaHarn</h1>
            <p style={{ color: "var(--color-text-secondary)" }}>Context-grounded coding agent, built on Pi.</p>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                value={repoPath}
                onChange={(e) => setRepoPath(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && connect()}
                placeholder="/path/to/local/repo"
                style={{ flex: 1, padding: 8 }}
              />
              <button className="metaharn-btn-primary" onClick={connect}>
                Connect
              </button>
            </div>
            {connectError && (
              <p style={{ color: "var(--color-error)", fontSize: 13, marginTop: 8 }}>{connectError}</p>
            )}
          </>
        )}

        {view.kind === "settings" && <SettingsPage />}

        {view.kind === "projectsList" && (
          <ProjectsListPage
            projects={projects}
            sessions={sessions}
            activeCwd={activeCwd}
            onSelectProject={selectProject}
            onNewProject={newProject}
            onImportProject={importProject}
            onRemoveProject={removeProject}
            onArchiveProject={archiveProject}
            onUnarchiveProject={unarchiveProject}
          />
        )}

        {view.kind === "project" && (
          <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
            <button
              onClick={backToProjectsList}
              style={{
                alignSelf: "flex-start",
                border: "none",
                background: "transparent",
                color: "var(--color-text-secondary)",
                cursor: "pointer",
                marginBottom: 8,
                padding: 0,
                fontSize: 13,
              }}
            >
              ← Projects
            </button>
            <div
              style={{
                display: "flex",
                gap: 4,
                borderBottom: "1px solid var(--color-border)",
                flexShrink: 0,
                marginBottom: 16,
              }}
            >
              {(["overview", "files"] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setView({ kind: "project", cwd: view.cwd, tab })}
                  style={{
                    padding: "8px 16px",
                    border: "none",
                    borderBottom: view.tab === tab ? "2px solid var(--color-accent)" : "2px solid transparent",
                    background: "transparent",
                    color: "var(--color-text)",
                    fontWeight: view.tab === tab ? 600 : 400,
                    cursor: "pointer",
                    textTransform: "capitalize",
                  }}
                >
                  {tab}
                </button>
              ))}
            </div>
            {/* Both panes stay mounted (CSS-toggled) so any unsaved file
                edits survive switching between Overview and Files. */}
            <div style={{ flex: 1, minHeight: 0, display: view.tab === "overview" ? "block" : "none" }}>
              <ProjectOverview
                cwd={view.cwd}
                sessions={sessions}
                activeSessionPath={activeSessionPath}
                installedAgents={installedAgents}
                sessionStatuses={sessionStatuses}
                worktreeLinks={worktreeLinks}
                onOpenSession={openSession}
                onNewChatSession={() => newChatSession(view.cwd)}
                onNewTerminalSession={(agentKind) => newTerminalSession(view.cwd, agentKind)}
                onArchiveSession={archiveSession}
                onDeleteSession={deleteSession}
                onResumeArchivedSession={resumeArchivedSession}
                onForkSession={forkSession}
                onQuickStart={(prompt) => quickStart(view.cwd, prompt)}
                onCreateWorktreeFromProject={() => createWorktreeFromProject(view.cwd)}
                onRemoveWorktree={removeWorktree}
              />
            </div>
            <div style={{ flex: 1, minHeight: 0, display: view.tab === "files" ? "block" : "none" }}>
              <FilesPane cwd={view.cwd} visible={view.tab === "files"} />
            </div>
          </div>
        )}

        {view.kind === "session" && (
          <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, position: "relative" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                borderBottom: "1px solid var(--color-border)",
                paddingBottom: 12,
                marginBottom: 16,
                flexShrink: 0,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                <button
                  onClick={() => backToProject(view.cwd)}
                  style={{
                    border: "none",
                    background: "transparent",
                    color: "var(--color-text-secondary)",
                    cursor: "pointer",
                    padding: 0,
                    fontSize: 13,
                    flexShrink: 0,
                  }}
                >
                  ← {projectLabel(view.cwd)}
                </button>
                <span style={{ color: "var(--color-text-muted)" }}>/</span>
                <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {currentChatSession ? sessionTitle(currentChatSession) : "New session"}
                </strong>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                {currentChatSession && (
                  <span
                    title={`Created ${currentChatSession.created.toLocaleString()}`}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 5,
                      border: "1px solid var(--color-border)",
                      borderRadius: 6,
                      color: "var(--color-text-secondary)",
                      padding: "5px 10px",
                      fontSize: 13,
                      fontFamily: '"IBM Plex Mono", Menlo, Monaco, monospace',
                    }}
                  >
                    <ClockIcon size={13} />
                    {formatAge(currentChatSession.created)}
                  </span>
                )}
                <button
                  onClick={toggleContext}
                  aria-label="Context window usage"
                  className="metaharn-tooltip"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 5,
                    border: "1px solid var(--color-border)",
                    borderRadius: 6,
                    background: showContext ? "var(--color-bg-hover)" : "transparent",
                    color: "var(--color-text)",
                    cursor: "pointer",
                    padding: "5px 10px",
                    fontSize: 13,
                    fontFamily: '"IBM Plex Mono", Menlo, Monaco, monospace',
                  }}
                >
                  <DatabaseIcon size={13} />
                  {sessionStats?.contextUsage?.percent !== undefined && sessionStats?.contextUsage?.percent !== null
                    ? `${sessionStats.contextUsage.percent.toFixed(0)}%`
                    : "—"}
                </button>
                <button
                  onClick={() => forkChatSession(view.cwd)}
                  disabled={streaming}
                  aria-label="Fork this session"
                  className="metaharn-tooltip"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    border: "1px solid var(--color-border)",
                    borderRadius: 6,
                    background: "transparent",
                    color: streaming ? "var(--color-text-muted)" : "var(--color-text)",
                    cursor: streaming ? "default" : "pointer",
                    padding: "5px 8px",
                    fontSize: 13,
                  }}
                >
                  <ForkIcon size={14} />
                </button>
                <button
                  onClick={toggleTree}
                  disabled={streaming}
                  aria-label="Session tree — branch to an earlier point"
                  className="metaharn-tooltip"
                  style={{
                    border: "1px solid var(--color-border)",
                    borderRadius: 6,
                    background: showTree ? "var(--color-bg-hover)" : "transparent",
                    color: streaming ? "var(--color-text-muted)" : "var(--color-text)",
                    cursor: streaming ? "default" : "pointer",
                    padding: "5px 12px",
                    fontSize: 13,
                  }}
                >
                  ⎇ Tree
                </button>
                <button
                  onClick={toggleGitPanel}
                  aria-label="Git — changes, branches, log"
                  className="metaharn-tooltip"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    border: "1px solid var(--color-border)",
                    borderRadius: 6,
                    background: showGitPanel ? "var(--color-bg-hover)" : "transparent",
                    color: "var(--color-text)",
                    cursor: "pointer",
                    padding: "5px 8px",
                    fontSize: 13,
                  }}
                >
                  <BranchIcon size={14} />
                </button>
                {streaming && (
                  <button
                    onClick={stopStreaming}
                    style={{
                      border: "1px solid var(--color-error)",
                      borderRadius: 6,
                      background: "transparent",
                      color: "var(--color-error)",
                      cursor: "pointer",
                      padding: "5px 12px",
                      fontSize: 13,
                    }}
                  >
                    ■ Stop
                  </button>
                )}
              </div>
            </div>

            {showContext && (
              <ContextWindowPanel stats={sessionStats} modelId={sessionStats?.model ?? appInfo?.modelId} onClose={() => setShowContext(false)} />
            )}

            {showTree && (
              <SessionTreeView nodes={sessionTree} onBranch={branchTo} onClose={() => setShowTree(false)} />
            )}

            {!ready && <p>Loading institutional context and starting session...</p>}

            {ready && (
              <>
                <div
                  ref={messagesContainerRef}
                  onScroll={handleMessagesScroll}
                  style={{
                    flex: 1,
                    minHeight: 0,
                    overflowY: "auto",
                    display: "flex",
                    flexDirection: "column",
                    gap: 10,
                    paddingRight: 4,
                  }}
                >
                  {messages.map((m, i) => {
                    if (m.role === "user") {
                      return (
                        <div
                          key={i}
                          style={{
                            borderLeft: "3px solid var(--color-accent)",
                            background: "var(--color-bg-secondary)",
                            borderRadius: "0 8px 8px 0",
                            padding: "8px 14px",
                            whiteSpace: "pre-wrap",
                          }}
                        >
                          {m.text}
                        </div>
                      );
                    }
                    if (m.role === "tool") {
                      const isError = m.status === "error";
                      const isPending = m.status === "pending";
                      return (
                        <div
                          key={i}
                          style={{
                            display: "flex",
                            alignItems: "baseline",
                            gap: 8,
                            color: isError ? "var(--color-error)" : "var(--color-text-muted)",
                            fontFamily: '"IBM Plex Mono", Menlo, Monaco, monospace',
                            fontSize: 12,
                            paddingLeft: 4,
                          }}
                        >
                          <span>
                            {isPending ? "→" : isError ? "✕" : "✓"} {m.text}
                          </span>
                          {m.detail && (
                            <span
                              style={{
                                color: "var(--color-text-muted)",
                                opacity: 0.75,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {m.detail}
                            </span>
                          )}
                        </div>
                      );
                    }
                    if (m.role === "thinking") {
                      return (
                        <div
                          key={i}
                          style={{
                            color: "var(--color-text-muted)",
                            fontStyle: "italic",
                            fontSize: 13,
                            padding: "0 4px",
                            whiteSpace: "pre-wrap",
                            lineHeight: 1.5,
                          }}
                        >
                          {m.text}
                        </div>
                      );
                    }
                    if (m.role === "system") {
                      return (
                        <div
                          key={i}
                          style={{
                            background: "var(--color-error-soft)",
                            color: "var(--color-error)",
                            borderRadius: 8,
                            padding: "8px 14px",
                            fontSize: 13,
                            whiteSpace: "pre-wrap",
                          }}
                        >
                          {m.text}
                        </div>
                      );
                    }
                    return (
                      <div key={i} style={{ padding: "0 4px", lineHeight: 1.5 }}>
                        {renderMarkdown(m.text, `msg-${i}`)}
                      </div>
                    );
                  })}
                </div>

                <div style={{ display: "flex", gap: 8, marginTop: 12, flexShrink: 0 }}>
                  <input
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && sendPrompt()}
                    placeholder="Ask about this repo..."
                    style={{ flex: 1, padding: 8 }}
                    disabled={streaming}
                  />
                  <button className="metaharn-btn-primary" onClick={sendPrompt} disabled={streaming}>
                    {streaming ? "..." : "Send"}
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {view.kind === "terminal" && (
          <div style={{ display: "flex", flexDirection: "column", flexShrink: 0, position: "relative" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                borderBottom: "1px solid var(--color-border)",
                paddingBottom: 12,
                marginBottom: 16,
                flexShrink: 0,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                <button
                  onClick={() => backToProject(view.cwd)}
                  style={{
                    border: "none",
                    background: "transparent",
                    color: "var(--color-text-secondary)",
                    cursor: "pointer",
                    padding: 0,
                    fontSize: 13,
                    flexShrink: 0,
                  }}
                >
                  ← {projectLabel(view.cwd)}
                </button>
                <span style={{ color: "var(--color-text-muted)" }}>/</span>
                <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {currentTerminalSession ? sessionTitle(currentTerminalSession) : "New terminal session"}
                </strong>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                {currentTerminalSession && (
                  <div style={{ position: "relative" }}>
                    <button
                      onClick={() => {
                        setShowContext(false);
                        setShowGitPanel(false);
                        setShowAgentSwap((v) => !v);
                      }}
                      disabled={swappingSessionId === currentTerminalSession.id}
                      title={
                        swappingSessionId === currentTerminalSession.id
                          ? "Swapping — asking the current agent to summarize for handoff..."
                          : "Swap this session's agent"
                      }
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 5,
                        border: "1px solid var(--color-border)",
                        borderRadius: 6,
                        background: showAgentSwap ? "var(--color-bg-hover)" : "transparent",
                        color:
                          swappingSessionId === currentTerminalSession.id ? "var(--color-text-muted)" : "var(--color-text)",
                        cursor: swappingSessionId === currentTerminalSession.id ? "default" : "pointer",
                        padding: "5px 10px",
                        fontSize: 13,
                        fontFamily: '"IBM Plex Mono", Menlo, Monaco, monospace',
                      }}
                    >
                      {swappingSessionId === currentTerminalSession.id
                        ? "swapping..."
                        : `${AGENT_DISPLAY_NAMES[currentTerminalSession.agentKind ?? "claude"]} ⌄`}
                    </button>
                    {showAgentSwap && (
                      <AgentSwapMenu
                        currentKind={currentTerminalSession.agentKind ?? "claude"}
                        installedKinds={installedAgents.map((a) => a.kind)}
                        onSwap={(kind) => {
                          setShowAgentSwap(false);
                          swapTerminalAgent(currentTerminalSession, kind);
                        }}
                        onGoToInstall={() => {
                          setShowAgentSwap(false);
                          setView({ kind: "settings" });
                        }}
                        onClose={() => setShowAgentSwap(false)}
                      />
                    )}
                  </div>
                )}
                <button
                  onClick={toggleContext}
                  disabled={!currentTerminalSession}
                  aria-label="Context window usage (estimated from the session transcript)"
                  className="metaharn-tooltip"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 5,
                    border: "1px solid var(--color-border)",
                    borderRadius: 6,
                    background: showContext ? "var(--color-bg-hover)" : "transparent",
                    color: currentTerminalSession ? "var(--color-text)" : "var(--color-text-muted)",
                    cursor: currentTerminalSession ? "pointer" : "default",
                    padding: "5px 10px",
                    fontSize: 13,
                    fontFamily: '"IBM Plex Mono", Menlo, Monaco, monospace',
                  }}
                >
                  <DatabaseIcon size={13} />
                  {sessionStats?.contextUsage?.percent !== undefined && sessionStats?.contextUsage?.percent !== null
                    ? `${sessionStats.contextUsage.percent.toFixed(0)}%`
                    : "—"}
                </button>
                {currentTerminalSession && (
                  <span
                    title={`Created ${currentTerminalSession.created.toLocaleString()}`}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 5,
                      border: "1px solid var(--color-border)",
                      borderRadius: 6,
                      color: "var(--color-text-secondary)",
                      padding: "5px 10px",
                      fontSize: 13,
                      fontFamily: '"IBM Plex Mono", Menlo, Monaco, monospace',
                    }}
                  >
                    <ClockIcon size={13} />
                    {formatAge(currentTerminalSession.created)}
                  </span>
                )}
                <button
                  onClick={() => currentTerminalSession && forkTerminalSession(currentTerminalSession)}
                  disabled={!currentTerminalSession || currentTerminalSession.agentKind === "gemini"}
                  aria-label={
                    currentTerminalSession?.agentKind === "gemini"
                      ? "Forking isn't supported for Gemini sessions yet"
                      : "Fork this session"
                  }
                  className="metaharn-tooltip"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    border: "1px solid var(--color-border)",
                    borderRadius: 6,
                    background: "transparent",
                    color:
                      currentTerminalSession && currentTerminalSession.agentKind !== "gemini"
                        ? "var(--color-text)"
                        : "var(--color-text-muted)",
                    cursor: currentTerminalSession && currentTerminalSession.agentKind !== "gemini" ? "pointer" : "default",
                    padding: "5px 8px",
                    fontSize: 13,
                  }}
                >
                  <ForkIcon size={14} />
                </button>
                <button
                  onClick={toggleGitPanel}
                  aria-label="Git — changes, branches, log"
                  className="metaharn-tooltip"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    border: "1px solid var(--color-border)",
                    borderRadius: 6,
                    background: showGitPanel ? "var(--color-bg-hover)" : "transparent",
                    color: "var(--color-text)",
                    cursor: "pointer",
                    padding: "5px 8px",
                    fontSize: 13,
                  }}
                >
                  <BranchIcon size={14} />
                </button>
                <button
                  onClick={toggleTerminalGrid}
                  aria-label="Session grid — view multiple terminals at once"
                  className="metaharn-tooltip"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    border: "1px solid var(--color-border)",
                    borderRadius: 6,
                    background: showTerminalGrid ? "var(--color-bg-hover)" : "transparent",
                    color: "var(--color-text)",
                    cursor: "pointer",
                    padding: "5px 8px",
                    fontSize: 13,
                  }}
                >
                  <GridIcon size={14} />
                </button>
                <button
                  onClick={() => currentTerminalSession && closeTerminalTab(currentTerminalSession.id)}
                  disabled={!currentTerminalSession}
                  aria-label="Close this tab (the session itself isn't deleted — reopen it from the sidebar anytime)"
                  className="metaharn-tooltip"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    border: "1px solid var(--color-border)",
                    borderRadius: 6,
                    background: "transparent",
                    color: currentTerminalSession ? "var(--color-text)" : "var(--color-text-muted)",
                    cursor: currentTerminalSession ? "pointer" : "default",
                    padding: "5px 8px",
                    fontSize: 13,
                    lineHeight: 1,
                  }}
                >
                  ×
                </button>
              </div>
            </div>

            {showContext && (
              <ContextWindowPanel stats={sessionStats} modelId={sessionStats?.model} onClose={() => setShowContext(false)} />
            )}
          </div>
        )}

        {/* Every open terminal tab stays mounted here UNCONDITIONALLY (CSS-
            toggled, not inside the `view.kind === "terminal"` block above,
            which itself unmounts on navigating away) — same co-mounted
            pattern as Overview/Files. This is what actually keeps a tab's
            xterm scrollback and its real pty connection alive across BOTH
            switching to a different tab AND navigating away to
            Overview/Files/a different project entirely, not just the
            former. Force-hidden (not unmounted) while the grid is showing —
            the grid replaces this view, it doesn't sit alongside it; a
            session placed in BOTH gets a second, independent TerminalPane
            instance there (safe: metaharnPty.create is attach-or-create, and
            ptyData broadcasts to every listener — see TerminalGrid.tsx's
            own doc comment for the real trade-off this implies). */}
        {openTerminalTabs.map(({ id, cwd, generation }) => {
          const isActive = !showTerminalGrid && view.kind === "terminal" && view.terminalSessionId === id;
          return (
            <div
              // generation changes on an in-place agent swap (see
              // swapTerminalAgent) — a new key forces React to fully
              // unmount/remount TerminalPane, which is what makes it call
              // metaharnPty.create() again and pick up the newly-swapped
              // agent instead of reattaching to whatever pty already
              // existed for this session id.
              key={`${id}:${generation}`}
              style={{
                display: isActive ? "block" : "none",
                flex: 1,
                minHeight: 0,
                border: "1px solid var(--color-border)",
                borderRadius: 8,
                overflow: "hidden",
              }}
            >
              <TerminalPane
                cwd={cwd}
                terminalSessionId={id}
                // Only offer to auto-title a genuinely new session — a
                // reopened one keeps whatever title it already has. Only
                // relevant for the tab that was *just* created fresh
                // (resume:false in view at the moment it was opened) — read
                // once at this pane's first mount, same as every other prop
                // TerminalPane only consumes on mount.
                onFirstInput={
                  isActive && view.kind === "terminal" && !view.resume ? (line) => titleTerminalSession(id, line) : undefined
                }
                visible={isActive}
                onProcessExit={() => markTerminalExited(id)}
              />
            </div>
          );
        })}

        {showTerminalGrid && view.kind === "terminal" && (
          <TerminalGrid
            sessionIds={gridSessionIds.filter((id) => openTerminalTabs.some((t) => t.id === id))}
            openTerminalTabs={openTerminalTabs}
            sessions={sessions}
            cols={gridCols}
            onColsChange={setGridCols}
            onAddAll={addAllToGrid}
            onEmpty={emptyGrid}
            onRemove={removeFromGrid}
            onReorder={reorderGrid}
            onProcessExit={markTerminalExited}
          />
        )}
        </main>

        {showGitPanel && activeCwd && (
          <aside
            style={{
              width: 440,
              flexShrink: 0,
              borderLeft: "1px solid var(--color-border)",
              background: "var(--color-bg-secondary)",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <GitPanel
              cwd={activeCwd}
              worktreeLinks={worktreeLinks}
              requestConfirm={setPendingConfirm}
              onClose={() => setShowGitPanel(false)}
              onOpenBranchExplorer={(branch) => {
                setShowGitPanel(false);
                void window.metaharn.openBranchExplorerWindow(activeCwd, branch);
              }}
            />
          </aside>
        )}
      </div>

      {pendingConfirm && (
        <ConfirmDialog
          message={pendingConfirm.message}
          details={pendingConfirm.details}
          onConfirm={pendingConfirm.onConfirm}
          onCancel={() => setPendingConfirm(null)}
        />
      )}
    </div>
  );
}
