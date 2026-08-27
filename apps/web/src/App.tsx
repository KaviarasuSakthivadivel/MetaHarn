import { useEffect, useMemo, useRef, useState } from "react";
import * as client from "./client.js";
import type { ApprovalOutcome, HistoryMessage, ServerEvent, SessionListItem, SessionTreeNode, TokenUsage } from "./client.js";
import { isNativePickerAvailable, pickFolder } from "./folderPicker.js";
import Settings from "./Settings.js";
import Markdown, { type CanvasPayload } from "./Markdown.js";
import CanvasPanel from "./CanvasPanel.js";
import Connectors from "./Connectors.js";
import InboxPage from "./InboxPage.js";
import SessionTree from "./SessionTree.js";
import SessionPanel from "./SessionPanel.js";
import { humanizeTool } from "./humanize.js";

interface ChatMessage {
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  toolCallId?: string;
  status?: "pending" | "done" | "error";
  args?: unknown;
  result?: unknown;
  // This message's position in the underlying ChatMessage[] on the server — lets the inline
  // "branch from here" button construct the exact `${sessionId}:${index}` node id branchTo()
  // already expects. Undefined for a "system" row (a client-side error notice, not a real
  // message) and briefly undefined for a just-sent message too, until its message_index event
  // arrives (see the "message_index" case in the event switch below).
  index?: number;
}

interface PendingPermission {
  toolCallId: string;
  toolName: string;
  args: unknown;
  reason: string;
}

type View = "landing" | "chat" | "settings" | "automations" | "connectors" | "inbox";

function historyToMessages(history: HistoryMessage[]): ChatMessage[] {
  return history.map((h) => ({ role: h.role, text: h.text, index: h.index }));
}

function basename(path: string): string {
  return path.replace(/\/+$/, "").split(/[\\/]/).pop() || path;
}

function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

const ZERO_USAGE: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function toolPayloadFence(value: unknown, language = ""): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const fenceLanguage = language || (typeof value === "string" ? "" : "json");
  return "```" + fenceLanguage + "\n" + text + "\n```";
}

function relativeTime(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function IconSearch() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function IconFolder() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </svg>
  );
}

function IconBolt() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polygon points="13 2 3 14 11 14 9 22 21 10 13 10 13 2" />
    </svg>
  );
}

function IconPlug() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M9 2v6M15 2v6M6 8h12l-1.5 8a4 4 0 0 1-4 3.4h-1a4 4 0 0 1-4-3.4L6 8Z" />
      <path d="M12 19.4V22" />
    </svg>
  );
}

function IconBell() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

function IconGear() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </svg>
  );
}

function IconSend() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}

export default function App() {
  const [connectError, setConnectError] = useState<string | undefined>();
  const [repoPath, setRepoPath] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [showTree, setShowTree] = useState(false);
  const [treeNodes, setTreeNodes] = useState<SessionTreeNode[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [pendingInboxCount, setPendingInboxCount] = useState(0);
  const [search, setSearch] = useState("");
  const [view, setView] = useState<View>("landing");
  const [pendingPermission, setPendingPermission] = useState<PendingPermission | null>(null);
  const [nativePicker, setNativePicker] = useState(false);
  const [usage, setUsage] = useState<TokenUsage>(ZERO_USAGE);
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const [canvasPayload, setCanvasPayload] = useState<CanvasPayload | null>(null);
  const [todos, setTodos] = useState<client.TodoItem[]>([]);
  const [roots, setRoots] = useState<client.RootDir[]>([]);
  const [showSessionPanel, setShowSessionPanel] = useState(false);
  const [groupOverrides, setGroupOverrides] = useState<Record<number, boolean>>({});
  const [webSearchEnabled, setWebSearchEnabledState] = useState(true);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    client.listSessions().then((r) => setSessions(r.sessions)).catch(() => {});
    isNativePickerAvailable().then(setNativePicker);
    client.getSettings().then((s) => setWebSearchEnabledState(s.webSearchEnabled)).catch(() => {});
  }, []);

  // Badge-only poll — InboxPage does its own on-demand fetch/refresh; this just keeps the
  // sidebar count roughly current without requiring the page to be open.
  useEffect(() => {
    const poll = () => client.listPendingInbox().then((r) => setPendingInboxCount(r.items.length)).catch(() => {});
    poll();
    const id = setInterval(poll, 20_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => () => unsubscribeRef.current?.(), []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  function appendToLastAssistant(delta: string) {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.role === "assistant") return [...prev.slice(0, -1), { ...last, text: last.text + delta }];
      return [...prev, { role: "assistant", text: delta }];
    });
  }

  function handleEvent(event: ServerEvent) {
    switch (event.type) {
      case "text_delta":
        appendToLastAssistant(event.delta);
        break;
      case "tool_start":
        setMessages((prev) => [...prev, { role: "tool", text: event.toolName, toolCallId: event.toolCallId, status: "pending", args: event.args }]);
        break;
      case "tool_end":
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.role === "tool" && m.toolCallId === event.toolCallId);
          const args = idx === -1 ? undefined : prev[idx].args;
          const updated: ChatMessage = { role: "tool", text: event.toolName, toolCallId: event.toolCallId, status: event.isError ? "error" : "done", args, result: event.result };
          return idx === -1 ? [...prev, updated] : [...prev.slice(0, idx), updated, ...prev.slice(idx + 1)];
        });
        // The "Progress" panel — todo_write replaces the plan wholesale each call, so its own
        // result already carries the full current list; no separate fetch needed. Not part of
        // `messages` at all, a parallel side-channel the tool just happens to travel through.
        if (event.toolName === "todo_write" && !event.isError && event.result && typeof event.result === "object") {
          const todosResult = (event.result as { todos?: unknown }).todos;
          if (Array.isArray(todosResult)) setTodos(todosResult as client.TodoItem[]);
        }
        break;
      case "permission_required":
        setPendingPermission({ toolCallId: event.toolCallId, toolName: event.toolName, args: event.args, reason: event.reason });
        break;
      case "agent_end":
        setStreaming(false);
        break;
      case "error":
        setMessages((prev) => [...prev, { role: "system", text: `Error: ${event.message}` }]);
        setStreaming(false);
        break;
      case "usage":
        setUsage(event.total);
        break;
      case "message_index":
        // Always targets the LAST message of that role — safe because a new bubble of a given
        // role is always appended (optimistically, for "user"; via appendToLastAssistant
        // creating one, for "assistant") strictly before the server round-trip that reports
        // its index arrives, and turns/steers within one session are never concurrent.
        setMessages((prev) => {
          const idx = prev.map((m) => m.role).lastIndexOf(event.role);
          if (idx === -1) return prev;
          return [...prev.slice(0, idx), { ...prev[idx], index: event.index }, ...prev.slice(idx + 1)];
        });
        break;
    }
  }

  async function connect(path: string, resumeId?: string) {
    if (!path.trim()) return;
    setConnectError(undefined);
    try {
      const { sessionId: id, history, usage: initialUsage, todos: initialTodos, roots: initialRoots } = await client.init(path, resumeId);
      unsubscribeRef.current?.();
      unsubscribeRef.current = await client.subscribe(id, handleEvent);
      setSessionId(id);
      setRepoPath(path);
      setMessages(historyToMessages(history));
      setUsage(initialUsage ?? ZERO_USAGE);
      setTodos(initialTodos ?? []);
      setRoots(initialRoots ?? []);
      setGroupOverrides({});
      setView("chat");
      client.listSessions().then((r) => setSessions(r.sessions)).catch(() => {});
    } catch (err) {
      setConnectError((err as Error).message);
    }
  }

  async function grantFolder(path: string, writable: boolean) {
    if (!sessionId || !path.trim()) return;
    try {
      const { root } = await client.addRoot(sessionId, path.trim(), writable);
      setRoots((prev) => [...prev, root]);
    } catch (err) {
      setMessages((prev) => [...prev, { role: "system", text: `Couldn't grant access: ${(err as Error).message}` }]);
    }
  }

  async function revokeFolder(path: string) {
    if (!sessionId) return;
    try {
      await client.removeRoot(sessionId, path);
      setRoots((prev) => prev.filter((r) => r.path !== path));
    } catch (err) {
      setMessages((prev) => [...prev, { role: "system", text: `Couldn't revoke access: ${(err as Error).message}` }]);
    }
  }

  async function toggleWebSearch(enabled: boolean) {
    setWebSearchEnabledState(enabled);
    try {
      await client.setWebSearchEnabled(enabled);
    } catch (err) {
      setWebSearchEnabledState(!enabled);
      setMessages((prev) => [...prev, { role: "system", text: `Couldn't update web search: ${(err as Error).message}` }]);
    }
  }

  async function browse() {
    const picked = await pickFolder(repoPath || undefined);
    if (picked) setRepoPath(picked);
  }

  function startNewSession() {
    unsubscribeRef.current?.();
    setSessionId(null);
    setMessages([]);
    setConnectError(undefined);
    setUsage(ZERO_USAGE);
    setView("landing");
  }

  async function forkCurrentSession() {
    if (!sessionId) return;
    try {
      const { sessionId: newId } = await client.forkSession(sessionId);
      await connect(repoPath, newId);
      client.listSessions().then((r) => setSessions(r.sessions)).catch(() => {});
    } catch (err) {
      setMessages((prev) => [...prev, { role: "system", text: `Couldn't fork session: ${(err as Error).message}` }]);
    }
  }

  async function toggleTree() {
    if (showTree) {
      setShowTree(false);
      return;
    }
    if (!sessionId) return;
    try {
      const { nodes } = await client.getSessionTree(sessionId);
      setTreeNodes(nodes);
      setShowTree(true);
    } catch (err) {
      setMessages((prev) => [...prev, { role: "system", text: `Couldn't load session tree: ${(err as Error).message}` }]);
    }
  }

  async function branchTo(nodeId: string) {
    setShowTree(false);
    const sep = nodeId.lastIndexOf(":");
    if (sep === -1) return;
    const targetId = nodeId.slice(0, sep);
    const messageIndex = Number(nodeId.slice(sep + 1));
    if (!Number.isInteger(messageIndex)) return;
    try {
      const { sessionId: newId } = await client.branchSession(targetId, messageIndex);
      await connect(repoPath, newId);
      client.listSessions().then((r) => setSessions(r.sessions)).catch(() => {});
    } catch (err) {
      setMessages((prev) => [...prev, { role: "system", text: `Couldn't branch session: ${(err as Error).message}` }]);
    }
  }

  async function send() {
    if (!sessionId || !input.trim()) return;
    const text = input.trim();
    setInput("");
    setMessages((prev) => [...prev, { role: "user", text }]);
    setStreaming(true);
    try {
      if (streaming) await client.steer(sessionId, text);
      else await client.prompt(sessionId, text);
    } catch (err) {
      setMessages((prev) => [...prev, { role: "system", text: `Error: ${(err as Error).message}` }]);
      setStreaming(false);
    }
  }

  async function resolve(outcome: ApprovalOutcome) {
    if (!sessionId || !pendingPermission) return;
    await client.resolvePermission(sessionId, pendingPermission.toolCallId, outcome);
    setPendingPermission(null);
  }

  const toolCallCount = useMemo(() => messages.filter((m) => m.role === "tool").length, [messages]);

  const filteredSessions = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) => s.name.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q));
  }, [sessions, search]);

  // A plain browser tab can't get a real absolute path out of a native OS picker (the File
  // System Access API only hands back a sandboxed handle, never a path a separate local server
  // could actually open) — so this is the fast path there instead of the native picker Tauri
  // gets: whatever repos you've already connected to, most-recent first, one click to reconnect
  // rather than retyping or re-browsing the same path. `sessions` is already sorted newest-first
  // by the server, so a simple first-seen dedupe by cwd preserves that order.
  const recentFolders = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const s of sessions) {
      if (seen.has(s.cwd)) continue;
      seen.add(s.cwd);
      out.push(s.cwd);
      if (out.length >= 6) break;
    }
    return out;
  }, [sessions]);

  // Groups every run of tool/assistant/system entries between two user messages into one
  // collapsible "steps" block — same shape as the reference: a live "Running N steps…" trace
  // instead of each tool call being its own top-level row in the transcript. Never touches
  // `messages` itself (branch points key off its real indices) — purely a render-time view.
  const renderItems = useMemo(() => {
    type Entry = { message: ChatMessage; i: number };
    type RenderItem =
      | { kind: "user"; message: ChatMessage; i: number }
      | { kind: "plain"; message: ChatMessage; i: number }
      | { kind: "group"; entries: Entry[]; startIndex: number; final?: Entry };

    // First pass: split on user messages, same as before — one "run" per turn.
    const runs: ({ kind: "user"; message: ChatMessage; i: number } | { kind: "run"; entries: Entry[]; startIndex: number })[] = [];
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.role === "user") {
        runs.push({ kind: "user", message: m, i });
        continue;
      }
      const last = runs[runs.length - 1];
      if (last?.kind === "run") last.entries.push({ message: m, i });
      else runs.push({ kind: "run", entries: [{ message: m, i }], startIndex: i });
    }

    // Second pass: a run's own trailing assistant text (once it has any) is the actual reply
    // to show, same as the reference — everything BEFORE it (tool calls, narration snippets)
    // is the "intermediate steps" trace, collapsed. A run with no tool calls at all — just one
    // assistant message — isn't a "trace" in the first place, so it renders plainly with no
    // collapsible wrapper at all: there's nothing to hide.
    const items: RenderItem[] = [];
    for (const r of runs) {
      if (r.kind === "user") {
        items.push(r);
        continue;
      }
      const entries = [...r.entries];
      const tail = entries[entries.length - 1];
      const final = tail?.message.role === "assistant" && tail.message.text.trim() ? entries.pop() : undefined;
      if (entries.length === 0) {
        if (final) items.push({ kind: "plain", message: final.message, i: final.i });
        continue;
      }
      items.push({ kind: "group", entries, startIndex: r.startIndex, final });
    }
    return items;
  }, [messages]);

  function isGroupExpanded(startIndex: number, isLast: boolean): boolean {
    if (startIndex in groupOverrides) return groupOverrides[startIndex];
    return isLast && streaming;
  }

  function toggleGroup(startIndex: number, isLast: boolean) {
    setGroupOverrides((prev) => ({ ...prev, [startIndex]: !isGroupExpanded(startIndex, isLast) }));
  }

  function renderMessage(m: ChatMessage, i: number) {
    if (m.role === "tool") {
      const key = m.toolCallId ?? String(i);
      const expanded = expandedTools.has(key);
      const line = humanizeTool(m.text, m.args);
      return (
        <div key={i} className="tool-row">
          <button
            className="tool-chip"
            onClick={() =>
              setExpandedTools((prev) => {
                const next = new Set(prev);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                return next;
              })
            }
          >
            <span className={`dot ${m.status}`} />
            <span className="tool-chip-line">
              <span className="tool-chip-pre">{line.pre}</span>
              {line.obj && <span className="tool-chip-obj">{line.obj}</span>}
              {line.post && <span className="tool-chip-post">{line.post}</span>}
            </span>
            <span className="tool-chip-caret">{expanded ? "▾" : "▸"}</span>
          </button>
          {expanded && (
            <div className="tool-detail">
              {m.args !== undefined && (
                <>
                  <div className="tool-detail-label">Arguments</div>
                  <Markdown onOpenCanvas={setCanvasPayload}>{toolPayloadFence(m.args)}</Markdown>
                </>
              )}
              {m.result !== undefined && (
                <>
                  <div className="tool-detail-label">Result</div>
                  <Markdown onOpenCanvas={setCanvasPayload}>{toolPayloadFence(m.result)}</Markdown>
                </>
              )}
            </div>
          )}
        </div>
      );
    }
    return (
      <div key={i} className="msg">
        <div className={`msg-avatar ${m.role}`}>{m.role === "user" ? "You" : m.role === "system" ? "!" : "M"}</div>
        <div className="msg-body">
          <div className="msg-role">{m.role}</div>
          {m.role === "system" ? (
            <div className="msg-text system">{m.text}</div>
          ) : (
            <div className="msg-text">
              <Markdown onOpenCanvas={setCanvasPayload}>{m.text}</Markdown>
            </div>
          )}
        </div>
        {m.index !== undefined && sessionId && (
          <button className="msg-branch" title="Branch from here — rewind to this point and continue differently" onClick={() => branchTo(`${sessionId}:${m.index}`)}>
            ⎇
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="sidebar-brand-mark">M</div>
          <div className="sidebar-brand-name">MetaHarn</div>
        </div>

        <button className="btn-new-session" onClick={startNewSession}>
          <span style={{ fontSize: 16, lineHeight: 1 }}>+</span> New session
        </button>

        <div className="sidebar-search">
          <IconSearch />
          <input placeholder="Search sessions" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>

        <div className="sidebar-nav">
          <button className={`sidebar-nav-item${view === "connectors" ? " active" : ""}`} onClick={() => setView("connectors")}>
            <IconPlug /> Connectors
          </button>
          <button className={`sidebar-nav-item${view === "inbox" ? " active" : ""}`} onClick={() => setView("inbox")} style={{ position: "relative" }}>
            <IconBell /> Inbox
            {pendingInboxCount > 0 && (
              <span
                style={{
                  marginLeft: "auto",
                  minWidth: 18,
                  height: 18,
                  padding: "0 5px",
                  borderRadius: 999,
                  background: "var(--accent)",
                  color: "#fff",
                  fontSize: 11,
                  fontWeight: 700,
                  lineHeight: "18px",
                  textAlign: "center",
                }}
              >
                {pendingInboxCount > 9 ? "9+" : pendingInboxCount}
              </span>
            )}
          </button>
          <button className={`sidebar-nav-item${view === "automations" ? " active" : ""}`} onClick={() => setView("automations")}>
            <IconBolt /> Automations
          </button>
          <button className={`sidebar-nav-item${view === "settings" ? " active" : ""}`} onClick={() => setView("settings")}>
            <IconGear /> Settings
          </button>
        </div>

        <div className="sidebar-section-label">Recent</div>
        <div className="sidebar-sessions">
          {filteredSessions.length === 0 && <div className="sidebar-empty">No sessions yet — point MetaHarn at a repo to start one.</div>}
          {filteredSessions.map((s) => {
            const parent = s.parentId ? sessions.find((p) => p.id === s.parentId) : undefined;
            return (
              <div key={s.id} className={`sidebar-session-card${s.id === sessionId ? " active" : ""}`} onClick={() => connect(s.cwd, s.id)}>
                <div className="sidebar-session-name">{s.name}</div>
                <div className="sidebar-session-meta">{basename(s.cwd)}</div>
                {s.parentId && <div className="sidebar-session-fork">↳ forked from {parent?.name ?? "a session"}</div>}
              </div>
            );
          })}
        </div>
      </aside>

      <main className="main">
        {view === "landing" && (
          <div className="landing">
            <div className="landing-inner">
              <div className="landing-eyebrow">Local agent server</div>
              <h1>Point MetaHarn at a repo.</h1>
              <p className="sub">Start a chat backed by the local agent server — reads, edits, shell commands, and memory, all running on this machine.</p>
              <div className="path-card">
                <label>Workspace path</label>
                <div className="path-row">
                  <input
                    className="path-input"
                    placeholder="/path/to/your/repo"
                    value={repoPath}
                    onChange={(e) => setRepoPath(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && connect(repoPath)}
                  />
                  {nativePicker && (
                    <button className="btn-browse" onClick={browse}>
                      <IconFolder /> Browse
                    </button>
                  )}
                </div>
                <div className="path-actions">
                  <button className="btn-primary accent" onClick={() => connect(repoPath)}>
                    Connect
                  </button>
                </div>
              </div>
              {connectError && <div className="error-banner">{connectError}</div>}
              {!nativePicker && <div className="landing-hint">Running in a browser tab — paste an absolute path above. The Tauri app adds a native folder picker.</div>}
              {recentFolders.length > 0 && (
                <div className="recent-folders">
                  <div className="recent-folders-label">Recent</div>
                  {recentFolders.map((path) => (
                    <button key={path} className="recent-folder-row" onClick={() => connect(path)}>
                      <IconFolder />
                      <span className="recent-folder-name">{basename(path)}</span>
                      <span className="recent-folder-path">{path}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {view === "settings" && <Settings workspace={repoPath || sessions[0]?.cwd || ""} />}
        {view === "automations" && <Settings workspace={repoPath || sessions[0]?.cwd || ""} initialTab="automations" />}
        {view === "connectors" && <Connectors workspace={repoPath || sessions[0]?.cwd || ""} />}
        {view === "inbox" && (
          <InboxPage
            sessions={sessions}
            onOpenSession={(s) => {
              setView("chat");
              void connect(s.cwd, s.id);
            }}
            onCountChange={setPendingInboxCount}
          />
        )}

        {view === "chat" && sessionId && (
          <div className="chat-screen">
          <div className="chat-main">
            <div className="chat-header">
              <div className="chat-header-title">
                <span className="chat-header-name">{basename(repoPath)}</span>
                <span className="chat-header-path">{repoPath}</span>
              </div>
              <div className="chat-header-actions">
                {(usage.input > 0 || usage.output > 0) && (
                  <span className="usage-pill" title={`${usage.input + usage.cacheRead + usage.cacheWrite} context tokens in · ${usage.output} out this session`}>
                    {formatTokenCount(usage.input + usage.output + usage.cacheRead + usage.cacheWrite)} tok
                  </span>
                )}
                <button className="btn-ghost" onClick={forkCurrentSession} disabled={messages.length === 0} title="Duplicate this conversation into a new session">
                  Fork
                </button>
                <button className="btn-ghost" onClick={toggleTree} disabled={messages.length === 0} title="Rewind to an earlier point and branch from it">
                  Tree
                </button>
                <button className={`btn-ghost${showSessionPanel ? " active" : ""}`} onClick={() => setShowSessionPanel((v) => !v)} title="Progress, folders, and sources for this session">
                  Session
                </button>
                <button className="btn-ghost" onClick={() => setView("settings")}>
                  Settings
                </button>
                <button className="btn-ghost" onClick={startNewSession}>
                  New session
                </button>
              </div>
            </div>
            {showTree && sessionId && (
              <SessionTree nodes={treeNodes} currentSessionId={sessionId} onBranch={branchTo} onClose={() => setShowTree(false)} />
            )}
            <div className="messages">
              {renderItems.map((item, idx) => {
                if (item.kind === "user" || item.kind === "plain") return renderMessage(item.message, item.i);
                const isLast = idx === renderItems.length - 1;
                const expanded = isGroupExpanded(item.startIndex, isLast);
                // Still "active" even once its own final answer starts streaming in below it —
                // only a later user message (a new run entirely) ends the active state, since
                // the trace and its answer are one continuous unit here.
                const isActive = isLast && streaming;
                const stepCount = item.entries.filter((e) => e.message.role === "tool").length || item.entries.length;
                return (
                  <div key={`group-${item.startIndex}`}>
                    <div className={`step-group${isActive ? " active" : ""}`}>
                      <button className="step-group-header" onClick={() => toggleGroup(item.startIndex, isLast)}>
                        <span className={`step-group-chevron${expanded ? " open" : ""}`}>›</span>
                        {isActive && !item.final ? `Running ${stepCount} step${stepCount === 1 ? "" : "s"}…` : `Ran ${stepCount} step${stepCount === 1 ? "" : "s"}`}
                      </button>
                      {expanded && <div className="step-group-body">{item.entries.map((e) => renderMessage(e.message, e.i))}</div>}
                    </div>
                    {item.final && renderMessage(item.final.message, item.final.i)}
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>
            <div className="composer-wrap">
              <div className="composer">
                <input
                  placeholder={streaming ? "Steer the running turn…" : "Message MetaHarn…"}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && send()}
                />
                {streaming && (
                  <button className="btn-stop" onClick={() => sessionId && client.abort(sessionId)}>
                    Stop
                  </button>
                )}
                <button className="btn-send" disabled={!input.trim()} onClick={send}>
                  <IconSend />
                </button>
              </div>
            </div>
          </div>
          {showSessionPanel && (
            <SessionPanel
              todos={todos}
              roots={roots}
              toolCallCount={toolCallCount}
              webSearchEnabled={webSearchEnabled}
              onGrantFolder={grantFolder}
              onRevokeFolder={revokeFolder}
              onToggleWebSearch={toggleWebSearch}
              onClose={() => setShowSessionPanel(false)}
            />
          )}
          </div>
        )}
      </main>

      {canvasPayload && <CanvasPanel payload={canvasPayload} onClose={() => setCanvasPayload(null)} />}

      {pendingPermission && (
        <div className="overlay" onClick={() => resolve("deny")}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Allow &ldquo;{pendingPermission.toolName}&rdquo;?</h3>
            <p className="reason">{pendingPermission.reason}</p>
            <pre className="args-preview">{JSON.stringify(pendingPermission.args, null, 2)}</pre>
            <div className="dialog-actions">
              <button className="btn-secondary" onClick={() => resolve("deny")}>
                Deny
              </button>
              <button
                className="btn-secondary"
                title={`Skip this prompt for every future "${pendingPermission.toolName}" call in this session`}
                onClick={() => resolve("always_tool")}
              >
                Always Allow
              </button>
              <button className="btn-primary accent" onClick={() => resolve("once")}>
                Allow
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
