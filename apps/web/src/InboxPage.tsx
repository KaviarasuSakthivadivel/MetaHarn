import { useEffect, useState } from "react";
import * as client from "./client.js";
import type { InboxItem, SessionListItem } from "./client.js";
import Markdown from "./Markdown.js";

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

function argsFence(args: Record<string, unknown> | undefined): string {
  if (!args || Object.keys(args).length === 0) return "";
  return "```json\n" + JSON.stringify(args, null, 2) + "\n```";
}

function IconClock() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" strokeLinecap="round" />
    </svg>
  );
}

function IconArrowRight() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <path d="M5 12h14M13 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconInboxEmpty() {
  return (
    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M4 12h4l2 3h4l2-3h4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 12l1.6-6.4A2 2 0 0 1 7.5 4h9a2 2 0 0 1 1.9 1.6L20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-6Z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
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
      <div className="inbox-header-row">
        <h2 style={{ marginBottom: 4 }}>Inbox</h2>
        {items && items.length > 0 && <span className="inbox-count">{items.length} pending</span>}
      </div>
      <p className="desc" style={{ margin: 0 }}>
        Approvals waiting on you, from any session — even one that isn't open right now.
      </p>

      {items !== null && items.length === 0 && (
        <div className="inbox-empty">
          <IconInboxEmpty />
          <h3>All clear</h3>
          <p>Nothing is waiting on you right now.</p>
        </div>
      )}

      <div className="inbox-list">
        {items?.map((item) => {
          const session = sessionFor(item.sessionId);
          const busy = resolvingId === item.id;
          const fence = argsFence(item.arguments);
          return (
            <div className="inbox-card" key={item.id}>
              <div className="inbox-card-status">
                <span className="inbox-status-dot" />
                Waiting on you
              </div>
              <div className="inbox-card-top">
                <div className="inbox-card-title">
                  {item.toolName ? (
                    <>
                      Run <code className="inline-code">{item.toolName}</code>?
                    </>
                  ) : (
                    item.title ?? "Approval needed"
                  )}
                </div>
                <div className="inbox-card-actions">
                  <button className="btn-sm outline" disabled={busy} onClick={() => resolve(item, "deny")}>
                    Deny
                  </button>
                  <button className="btn-sm accent" disabled={busy} onClick={() => resolve(item, "once")}>
                    Allow
                  </button>
                </div>
              </div>
              {item.body && <p className="inbox-card-reason">{item.body}</p>}
              {fence && (
                <div className="inbox-card-args">
                  <Markdown>{fence}</Markdown>
                </div>
              )}
              <button
                className="inbox-card-meta"
                data-clickable={session ? "true" : "false"}
                disabled={!session}
                onClick={() => session && onOpenSession(session)}
              >
                <IconClock />
                {session ? session.name : "Unknown session"} · {timeAgo(item.createdAt)}
                {session && <IconArrowRight />}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
