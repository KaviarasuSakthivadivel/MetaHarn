import { useEffect, useRef, useState } from "react";
import * as client from "./client.js";
import type { ApprovalOutcome, HistoryMessage, ServerEvent, SessionListItem } from "./client.js";

interface ChatMessage {
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  toolCallId?: string;
  status?: "pending" | "done" | "error";
}

interface PendingPermission {
  toolCallId: string;
  toolName: string;
  args: unknown;
  reason: string;
}

function historyToMessages(history: HistoryMessage[]): ChatMessage[] {
  return history.map((h) => ({ role: h.role, text: h.text }));
}

export default function App() {
  const [connectError, setConnectError] = useState<string | undefined>();
  const [repoPath, setRepoPath] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [pendingPermission, setPendingPermission] = useState<PendingPermission | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    client
      .listSessions()
      .then((r) => setSessions(r.sessions))
      .catch((err) => setConnectError((err as Error).message));
  }, []);

  useEffect(() => () => unsubscribeRef.current?.(), []);

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
        setMessages((prev) => [...prev, { role: "tool", text: event.toolName, toolCallId: event.toolCallId, status: "pending" }]);
        break;
      case "tool_end":
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.role === "tool" && m.toolCallId === event.toolCallId);
          const updated: ChatMessage = { role: "tool", text: event.toolName, toolCallId: event.toolCallId, status: event.isError ? "error" : "done" };
          return idx === -1 ? [...prev, updated] : [...prev.slice(0, idx), updated, ...prev.slice(idx + 1)];
        });
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
    }
  }

  async function connect(path: string, resumeId?: string) {
    setConnectError(undefined);
    try {
      const { sessionId: id, history } = await client.init(path, resumeId);
      unsubscribeRef.current?.();
      unsubscribeRef.current = await client.subscribe(id, handleEvent);
      setSessionId(id);
      setRepoPath(path);
      setMessages(historyToMessages(history));
    } catch (err) {
      setConnectError((err as Error).message);
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

  if (!sessionId) {
    return (
      <div style={styles.connectScreen}>
        <h1 style={styles.h1}>MetaHarn</h1>
        <p style={styles.sub}>Point this at a local repo to start a chat, backed by the local agent server.</p>
        <div style={styles.row}>
          <input
            style={styles.input}
            placeholder="/path/to/your/repo"
            value={repoPath}
            onChange={(e) => setRepoPath(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && connect(repoPath)}
          />
          <button style={styles.button} onClick={() => connect(repoPath)}>
            Connect
          </button>
        </div>
        {connectError && <p style={styles.error}>{connectError}</p>}
        {sessions.length > 0 && (
          <div style={{ marginTop: 24 }}>
            <h2 style={styles.h2}>Past sessions</h2>
            {sessions.map((s) => (
              <div key={s.id} style={styles.sessionRow} onClick={() => connect(s.cwd, s.id)}>
                <div style={{ fontWeight: 600 }}>{s.name}</div>
                <div style={styles.sessionMeta}>{s.cwd}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={styles.chatScreen}>
      <div style={styles.header}>
        <span>{repoPath}</span>
        <button style={styles.linkButton} onClick={() => setSessionId(null)}>
          switch project
        </button>
      </div>
      <div style={styles.messages}>
        {messages.map((m, i) => (
          <div key={i} style={m.role === "tool" ? styles.toolRow : styles.messageRow}>
            {m.role === "tool" ? (
              <span style={styles.toolChip}>
                {m.status === "pending" ? "⋯" : m.status === "error" ? "✕" : "✓"} {m.text}
              </span>
            ) : (
              <>
                <span style={styles.roleLabel}>{m.role}</span>
                <span style={m.role === "system" ? styles.systemText : undefined}>{m.text}</span>
              </>
            )}
          </div>
        ))}
      </div>
      <div style={styles.composer}>
        <input
          style={styles.input}
          placeholder={streaming ? "Steer the running turn..." : "Message MetaHarn..."}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
        />
        <button style={styles.button} onClick={send}>
          Send
        </button>
        {streaming && (
          <button style={styles.button} onClick={() => sessionId && client.abort(sessionId)}>
            Stop
          </button>
        )}
      </div>

      {pendingPermission && (
        <div style={styles.overlay} onClick={() => resolve("deny")}>
          <div style={styles.dialog} onClick={(e) => e.stopPropagation()}>
            <p style={{ margin: "0 0 6px", fontWeight: 600 }}>Allow "{pendingPermission.toolName}"?</p>
            <p style={{ margin: "0 0 10px", color: "#666" }}>{pendingPermission.reason}</p>
            <pre style={styles.argsPreview}>{JSON.stringify(pendingPermission.args, null, 2)}</pre>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button style={styles.buttonSecondary} onClick={() => resolve("deny")}>
                Deny
              </button>
              <button style={styles.button} onClick={() => resolve("once")}>
                Allow
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  connectScreen: { maxWidth: 560, margin: "80px auto", padding: "0 20px", fontFamily: "system-ui, sans-serif" },
  h1: { fontSize: 28, margin: "0 0 8px" },
  h2: { fontSize: 15, color: "#666", margin: "0 0 8px" },
  sub: { color: "#666", marginBottom: 20 },
  row: { display: "flex", gap: 8 },
  input: { flex: 1, padding: "10px 12px", border: "1px solid #ddd", borderRadius: 6, fontSize: 14 },
  button: { padding: "10px 16px", border: "none", borderRadius: 6, background: "#e0630f", color: "#fff", cursor: "pointer", fontSize: 14 },
  buttonSecondary: { padding: "10px 16px", border: "1px solid #ddd", borderRadius: 6, background: "transparent", cursor: "pointer", fontSize: 14 },
  linkButton: { border: "none", background: "none", color: "#e0630f", cursor: "pointer", fontSize: 13 },
  error: { color: "#b3402f", marginTop: 12 },
  sessionRow: { padding: "10px 12px", border: "1px solid #eee", borderRadius: 6, marginBottom: 6, cursor: "pointer" },
  sessionMeta: { fontSize: 12, color: "#999" },
  chatScreen: { display: "flex", flexDirection: "column", height: "100vh", fontFamily: "system-ui, sans-serif" },
  header: { padding: "12px 16px", borderBottom: "1px solid #eee", display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13, color: "#666" },
  messages: { flex: 1, overflowY: "auto", padding: 16 },
  messageRow: { marginBottom: 14, lineHeight: 1.5 },
  toolRow: { marginBottom: 8 },
  toolChip: { display: "inline-block", fontSize: 12, padding: "3px 8px", borderRadius: 999, background: "#f2f2f2", color: "#555" },
  roleLabel: { display: "block", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: "#999", marginBottom: 2 },
  systemText: { color: "#b3402f" },
  composer: { display: "flex", gap: 8, padding: 16, borderTop: "1px solid #eee" },
  overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" },
  dialog: { background: "#fff", borderRadius: 10, padding: 20, maxWidth: 480, width: "90%", boxShadow: "0 8px 24px rgba(0,0,0,0.25)" },
  argsPreview: { background: "#f7f7f7", border: "1px solid #eee", borderRadius: 6, padding: 10, fontSize: 12, maxHeight: 200, overflow: "auto", marginBottom: 14 },
};
