import { useEffect, useState } from "react";
import * as client from "./client.js";
import type { InboxItem, SessionListItem } from "./client.js";

interface InboxPageProps {
  sessions: SessionListItem[];
  onOpenSession: (session: SessionListItem) => void;
  onCountChange: (count: number) => void;
}

function timeAgo(ms: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Every still-pending HITL Inbox item across EVERY session, not just the one open right now —
 * closes the discoverability gap: the Inbox was durable (a pending approval survives a
 * restart) well before there was any way to find one without already having its session open.
 */
export default function InboxPage({ sessions, onOpenSession, onCountChange }: InboxPageProps) {
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  function refresh() {
    client.listPendingInbox().then((r) => {
      setItems(r.items);
      onCountChange(r.items.length);
    });
  }
  useEffect(refresh, []);

  async function resolve(item: InboxItem, outcome: "once" | "deny") {
    setResolvingId(item.id);
    try {
      await client.resolveInboxItem(item.id, outcome);
      refresh();
    } finally {
      setResolvingId(null);
    }
  }

  const sessionFor = (sessionId: string) => sessions.find((s) => s.id === sessionId);

  return (
    <div className="settings-body" style={{ maxWidth: 760, margin: "0 auto", width: "100%" }}>
      <h2 style={{ marginBottom: 4 }}>Inbox</h2>
      <p className="desc" style={{ margin: 0 }}>
        Approvals waiting on you, from any session — even one that isn't open right now.
      </p>

      {items !== null && items.length === 0 && (
        <div className="empty-state" style={{ marginTop: 20 }}>
          <h3>All clear</h3>
          <p>Nothing is waiting on you right now.</p>
        </div>
      )}

      <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 12 }}>
        {items?.map((item) => {
          const session = sessionFor(item.sessionId);
          const busy = resolvingId === item.id;
          return (
            <div className="list-card" key={item.id} style={{ alignItems: "flex-start", flexDirection: "column", gap: 10 }}>
              <div style={{ width: "100%", display: "flex", justifyContent: "space-between", gap: 12 }}>
                <div className="list-card-main">
                  <div className="list-card-title">{item.title ?? `Run \`${item.toolName ?? "tool"}\`?`}</div>
                  {item.body && <div className="list-card-sub">{item.body}</div>}
                  <button
                    className="list-card-sub"
                    style={{ border: "none", background: "transparent", padding: 0, cursor: session ? "pointer" : "default", color: session ? "var(--accent)" : undefined }}
                    disabled={!session}
                    onClick={() => session && onOpenSession(session)}
                  >
                    {session ? `${session.name} · ${timeAgo(item.createdAt)}` : `unknown session · ${timeAgo(item.createdAt)}`}
                  </button>
                </div>
                <div className="list-card-actions">
                  <button className="btn-sm" style={{ background: "transparent", color: "var(--text-muted)", border: "1px solid var(--line)" }} disabled={busy} onClick={() => resolve(item, "deny")}>
                    Deny
                  </button>
                  <button className="btn-sm" style={{ background: "var(--ink)", color: "#fff" }} disabled={busy} onClick={() => resolve(item, "once")}>
                    Allow
                  </button>
                </div>
              </div>
              {item.arguments && (
                <pre
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    fontFamily: "var(--font-mono)",
                    fontSize: 11.5,
                    color: "var(--text-muted)",
                    background: "var(--paper-dim)",
                    border: "1px solid var(--line)",
                    borderRadius: 8,
                    padding: 10,
                    margin: 0,
                    overflowX: "auto",
                    maxHeight: 140,
                  }}
                >
                  {JSON.stringify(item.arguments, null, 1)}
                </pre>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
