import { useEffect, useMemo, useRef, useState } from "react";
import * as client from "./client.js";
import type { ApprovalOutcome, HistoryMessage, ProviderStatus, ServerEvent, SessionListItem, SessionModel, SessionTreeNode, TokenUsage } from "./client.js";
import { isNativePickerAvailable, pickFolder } from "./folderPicker.js";
import { PROVIDER_MODELS, ProviderIcon } from "./providerCatalog.js";
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

function IconFork() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <circle cx="12" cy="18" r="2.5" />
      <path d="M6 8.5v2A2.5 2.5 0 0 0 8.5 13H12M18 8.5v2A2.5 2.5 0 0 1 15.5 13H12M12 13v2.5" />
    </svg>
  );
}

function IconBranch() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}

function IconPanelRight() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <line x1="15" y1="4" x2="15" y2="20" />
    </svg>
  );
}

function IconPlus() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function IconPencil() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconTrash() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 6h18" strokeLinecap="round" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <line x1="10" y1="11" x2="10" y2="17" strokeLinecap="round" />
      <line x1="14" y1="11" x2="14" y2="17" strokeLinecap="round" />
    </svg>
  );
}

function IconChevronDown() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
      <polyline points="6 9 12 15 18 9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Composer's model picker — providers filtered to only the ones actually configured (a key
 * saved, or signed in for the ChatGPT-subscription OAuth provider), each showing its curated
 * model list from providerCatalog.ts. Re-fetches the provider list on open, not just on
 * mount, so adding a key in Settings and coming straight back shows up without a reload. */
function ModelPicker({
  current,
  onSelect,
  onOpen,
  providers,
}: {
  current: SessionModel | null;
  onSelect: (provider: string, modelId: string) => void;
  onOpen: () => void;
  providers: ProviderStatus[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const configured = providers.filter((p) => p.configured);
  const currentLabel = current ? (PROVIDER_MODELS[current.provider]?.find((m) => m.id === current.modelId)?.label ?? current.modelId) : "Model";

  return (
    <div className="model-picker" ref={ref}>
      <button
        type="button"
        className="model-picker-trigger"
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) onOpen();
        }}
      >
        <span className="model-picker-icon">
          <ProviderIcon name={current?.provider ?? ""} />
        </span>
        <span className="model-picker-label">{currentLabel}</span>
        <IconChevronDown />
      </button>
      {open && (
        <div className="model-picker-menu">
          {configured.length === 0 ? (
            <div className="model-picker-empty">No providers configured yet — add one in Settings ▸ Models.</div>
          ) : (
            configured.map((p) => (
              <div className="model-picker-group" key={p.name}>
                <div className="model-picker-group-label">
                  <ProviderIcon name={p.name} />
                  {p.displayName}
                </div>
                {(PROVIDER_MODELS[p.name] ?? []).map((m) => (
                  <button
                    type="button"
                    key={m.id}
                    className={`model-picker-option${current?.provider === p.name && current?.modelId === m.id ? " active" : ""}`}
                    onClick={() => {
                      onSelect(p.name, m.id);
                      setOpen(false);
                    }}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      )}
    </div>
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
  const [pickerBusy, setPickerBusy] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [usage, setUsage] = useState<TokenUsage>(ZERO_USAGE);
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const [canvasPayload, setCanvasPayload] = useState<CanvasPayload | null>(null);
  const [todos, setTodos] = useState<client.TodoItem[]>([]);
  const [roots, setRoots] = useState<client.RootDir[]>([]);
  const [showSessionPanel, setShowSessionPanel] = useState(false);
  const [groupOverrides, setGroupOverrides] = useState<Record<number, boolean>>({});
  const [webSearchEnabled, setWebSearchEnabledState] = useState(true);
  const [currentModel, setCurrentModel] = useState<SessionModel | null>(null);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  function refreshProviders() {
    client.listProviders().then((r) => setProviders(r.providers)).catch(() => {});
  }

  useEffect(() => {
    client.listSessions().then((r) => setSessions(r.sessions)).catch(() => {});
    isNativePickerAvailable().then(setNativePicker);
    client.getSettings().then((s) => setWebSearchEnabledState(s.webSearchEnabled)).catch(() => {});
    refreshProviders();
  }, []);

  // Auto-grow the composer textarea up to a cap (shell.css bounds it visually too) — plain
  // height reset + re-measure, the standard technique since a textarea can't report its own
  // "natural" height without first collapsing to let scrollHeight reflect the new content.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

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
      const { sessionId: id, history, usage: initialUsage, todos: initialTodos, roots: initialRoots, model } = await client.init(path, resumeId);
      unsubscribeRef.current?.();
      unsubscribeRef.current = await client.subscribe(id, handleEvent);
      setSessionId(id);
      setRepoPath(path);
      setMessages(historyToMessages(history));
      setUsage(initialUsage ?? ZERO_USAGE);
      setTodos(initialTodos ?? []);
      setRoots(initialRoots ?? []);
      setCurrentModel(model ?? null);
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
    if (nativePicker) {
      const picked = await pickFolder(repoPath || undefined);
      if (picked) setRepoPath(picked);
      return;
    }
    // Plain browser tab: still a real OS dialog, just opened server-side (the server runs
    // locally and can shell out to osascript/PowerShell/zenity) rather than Tauri's own.
    setPickerBusy(true);
    try {
      const result = await client.pickFolderNative();
      if (result.ok) setRepoPath(result.path);
      else if (result.error) setConnectError(`Couldn't open a folder picker: ${result.error} — paste a path instead.`);
    } catch (err) {
      setConnectError(`Couldn't open a folder picker: ${(err as Error).message}`);
    } finally {
      setPickerBusy(false);
    }
  }

  function startNewSession() {
    unsubscribeRef.current?.();
    setSessionId(null);
    setMessages([]);
    setConnectError(undefined);
    setUsage(ZERO_USAGE);
    setView("landing");
  }

  function startRename(s: SessionListItem) {
    setRenamingId(s.id);
    setRenameDraft(s.name);
  }

  async function commitRename(id: string) {
    const title = renameDraft.trim();
    setRenamingId(null);
    if (!title) return;
    const prev = sessions.find((s) => s.id === id);
    if (!prev || prev.name === title) return;
    setSessions((cur) => cur.map((s) => (s.id === id ? { ...s, name: title } : s)));
    try {
      await client.renameSession(id, title);
    } catch (err) {
      setSessions((cur) => cur.map((s) => (s.id === id ? { ...s, name: prev.name } : s)));
      setMessages((prevMsgs) => [...prevMsgs, { role: "system", text: `Couldn't rename session: ${(err as Error).message}` }]);
    }
  }

  async function deleteSessionById(s: SessionListItem) {
    if (!window.confirm(`Delete "${s.name}"? This can't be undone.`)) return;
    setSessions((cur) => cur.filter((x) => x.id !== s.id));
    try {
      await client.deleteSession(s.id);
    } catch (err) {
      client.listSessions().then((r) => setSessions(r.sessions)).catch(() => {});
      setMessages((prev) => [...prev, { role: "system", text: `Couldn't delete session: ${(err as Error).message}` }]);
      return;
    }
    if (s.id === sessionId) startNewSession();
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

  async function switchModel(provider: string, modelId: string) {
    if (!sessionId) return;
    const previous = currentModel;
    setCurrentModel({ provider, modelId }); // optimistic — the picker should feel instant
    try {
      const { model } = await client.setSessionModel(sessionId, provider, modelId);
      setCurrentModel(model);
    } catch (err) {
      setCurrentModel(previous);
      setMessages((prev) => [...prev, { role: "system", text: `Couldn't switch model: ${(err as Error).message}` }]);
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

  // One group per workspace (cwd), in the order its most-recently-active session appears in
  // filteredSessions — which is already server-sorted newest-first, so this is "most recently
  // used project" ordering for free, not a separate sort.
  const groupedSessions = useMemo(() => {
    const order: string[] = [];
    const byCwd = new Map<string, SessionListItem[]>();
    for (const s of filteredSessions) {
      if (!byCwd.has(s.cwd)) {
        byCwd.set(s.cwd, []);
        order.push(s.cwd);
      }
      byCwd.get(s.cwd)!.push(s);
    }
    return order.map((cwd) => ({ cwd, sessions: byCwd.get(cwd)! }));
  }, [filteredSessions]);

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
          {groupedSessions.map((group) => (
            <div className="sidebar-group" key={group.cwd}>
              <div className="sidebar-group-label" title={group.cwd}>
                <IconFolder /> {basename(group.cwd)}
              </div>
              {group.sessions.map((s) => {
                const parent = s.parentId ? sessions.find((p) => p.id === s.parentId) : undefined;
                const renaming = renamingId === s.id;
                return (
                  <div
                    key={s.id}
                    className={`sidebar-session-card${s.id === sessionId ? " active" : ""}`}
                    onClick={() => !renaming && connect(s.cwd, s.id)}
                    onDoubleClick={() => startRename(s)}
                  >
                    <div className="sidebar-session-row">
                      {renaming ? (
                        <input
                          className="sidebar-session-rename-input"
                          autoFocus
                          value={renameDraft}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setRenameDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitRename(s.id);
                            if (e.key === "Escape") setRenamingId(null);
                          }}
                          onBlur={() => commitRename(s.id)}
                        />
                      ) : (
                        <div className="sidebar-session-name">{s.name}</div>
                      )}
                      <div className="sidebar-session-actions">
                        <button className="sidebar-session-icon-btn" title="Rename" aria-label="Rename" onClick={(e) => { e.stopPropagation(); startRename(s); }}>
                          <IconPencil />
                        </button>
                        <button className="sidebar-session-icon-btn danger" title="Delete" aria-label="Delete" onClick={(e) => { e.stopPropagation(); void deleteSessionById(s); }}>
                          <IconTrash />
                        </button>
                      </div>
                    </div>
                    <div className="sidebar-session-meta">{relativeTime(s.modified)} · {s.messageCount} msg{s.messageCount === 1 ? "" : "s"}</div>
                    {s.parentId && <div className="sidebar-session-fork">↳ forked from {parent?.name ?? "a session"}</div>}
                  </div>
                );
              })}
            </div>
          ))}
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
                  <button className="btn-browse" onClick={browse} disabled={pickerBusy}>
                    <IconFolder /> {pickerBusy ? "Waiting for picker…" : "Browse"}
                  </button>
                </div>
                <div className="path-actions">
                  <button className="btn-primary accent" onClick={() => connect(repoPath)}>
                    Connect
                  </button>
                </div>
              </div>
              {connectError && <div className="error-banner">{connectError}</div>}
              {!nativePicker && <div className="landing-hint">Running in a browser tab — Browse opens the OS folder dialog through the local server; paste an absolute path works too.</div>}
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
                <button className="btn-ghost icon-only" onClick={forkCurrentSession} disabled={messages.length === 0} title="Fork — duplicate this conversation into a new session">
                  <IconFork />
                </button>
                <button className="btn-ghost icon-only" onClick={toggleTree} disabled={messages.length === 0} title="Tree — rewind to an earlier point and branch from it">
                  <IconBranch />
                </button>
                <button className={`btn-ghost icon-only${showSessionPanel ? " active" : ""}`} onClick={() => setShowSessionPanel((v) => !v)} title="Session — progress, folders, and sources for this session">
                  <IconPanelRight />
                </button>
                <button className="btn-ghost icon-only" onClick={startNewSession} title="New session">
                  <IconPlus />
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
                <textarea
                  ref={textareaRef}
                  className="composer-textarea"
                  rows={1}
                  placeholder={streaming ? "Steer the running turn…" : "Message MetaHarn…"}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      send();
                    }
                  }}
                />
                <div className="composer-toolbar">
                  <ModelPicker current={currentModel} providers={providers} onSelect={switchModel} onOpen={refreshProviders} />
                  <div className="composer-toolbar-spacer" />
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
