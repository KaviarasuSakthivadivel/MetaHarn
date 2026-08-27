import { useEffect, useState } from "react";
import type { OwnedInboxItem, SessionListItem } from "../preload/preload.js";
import { Eyebrow, Section, SPACE, TEXT } from "./ui.js";
import { formatAge } from "./format.js";

interface InboxPageProps {
  sessions: SessionListItem[];
  onOpenSession: (session: SessionListItem) => void;
  onCountChange: (count: number) => void;
}

/**
 * Every still-pending HITL Inbox item across EVERY owned-engine session, not just the one
 * currently open — closes the discoverability gap flagged in
 * docs/architecture/08-known-limitations.md: the Inbox's durability was real (a pending
 * approval survives a restart) well before there was any way to find one without already
 * having its session open.
 */
export default function InboxPage({ sessions, onOpenSession, onCountChange }: InboxPageProps) {
  const [items, setItems] = useState<OwnedInboxItem[] | null>(null);
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  const refresh = () => {
    void window.metaharn.listOwnedPendingInbox().then((list) => {
      setItems(list);
      onCountChange(list.length);
    });
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resolve = async (item: OwnedInboxItem, outcome: "once" | "deny") => {
    setResolvingId(item.id);
    try {
      await window.metaharn.resolveOwnedInboxItem(item.id, outcome);
      refresh();
    } finally {
      setResolvingId(null);
    }
  };

  const sessionFor = (sessionId: string) => sessions.find((s) => s.id === sessionId);

  return (
    <div style={{ padding: SPACE.xl, maxWidth: 760, margin: "0 auto", width: "100%" }}>
      <Eyebrow>Inbox</Eyebrow>
      <h1 style={{ fontSize: TEXT.xxl, fontWeight: 700, margin: `${SPACE.xs}px 0 ${SPACE.lg}px`, color: "var(--color-text)" }}>
        Pending approvals
      </h1>

      {items === null ? (
        <p style={{ color: "var(--color-text-secondary)", fontSize: TEXT.base }}>Loading…</p>
      ) : items.length === 0 ? (
        <Section title="All clear">
          <p style={{ color: "var(--color-text-secondary)", fontSize: TEXT.base, margin: 0, padding: `${SPACE.sm}px 0` }}>
            Nothing is waiting on you. A tool call that needs approval — from any session, even one that
            isn't open right now — will show up here.
          </p>
        </Section>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: SPACE.md }}>
          {items.map((item) => {
            const session = sessionFor(item.sessionId);
            const busy = resolvingId === item.id;
            return (
              <div
                key={item.id}
                style={{
                  border: "1px solid var(--color-border)",
                  borderRadius: 10,
                  padding: SPACE.lg,
                  background: "var(--color-bg-secondary)",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: SPACE.md }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: TEXT.md, fontWeight: 700, color: "var(--color-text)" }}>
                      {item.title ?? `Run \`${item.toolName ?? "tool"}\`?`}
                    </div>
                    {item.body && (
                      <div style={{ fontSize: TEXT.sm, color: "var(--color-text-secondary)", marginTop: 4 }}>{item.body}</div>
                    )}
                    {item.arguments && (
                      <pre
                        style={{
                          fontSize: TEXT.xs,
                          color: "var(--color-text-secondary)",
                          background: "var(--color-bg)",
                          border: "1px solid var(--color-border)",
                          borderRadius: 6,
                          padding: SPACE.sm,
                          marginTop: SPACE.sm,
                          overflowX: "auto",
                          maxHeight: 120,
                        }}
                      >
                        {JSON.stringify(item.arguments, null, 1)}
                      </pre>
                    )}
                    <button
                      onClick={() => session && onOpenSession(session)}
                      disabled={!session}
                      style={{
                        marginTop: SPACE.sm,
                        border: "none",
                        background: "transparent",
                        color: session ? "var(--color-accent)" : "var(--color-text-secondary)",
                        cursor: session ? "pointer" : "default",
                        fontSize: TEXT.xs,
                        padding: 0,
                      }}
                    >
                      {session ? `${session.name} · ${formatAge(new Date(item.createdAt))} ago` : "session no longer available"}
                    </button>
                  </div>
                  <div style={{ display: "flex", gap: SPACE.xs, flexShrink: 0 }}>
                    <button
                      onClick={() => resolve(item, "deny")}
                      disabled={busy}
                      style={{
                        border: "1px solid var(--color-border)",
                        borderRadius: 6,
                        background: "transparent",
                        color: "var(--color-text)",
                        cursor: busy ? "default" : "pointer",
                        padding: "6px 12px",
                        fontSize: TEXT.sm,
                        fontWeight: 600,
                      }}
                    >
                      Deny
                    </button>
                    <button
                      onClick={() => resolve(item, "once")}
                      disabled={busy}
                      style={{
                        border: "none",
                        borderRadius: 6,
                        background: "var(--color-accent)",
                        color: "#fff",
                        cursor: busy ? "default" : "pointer",
                        padding: "6px 12px",
                        fontSize: TEXT.sm,
                        fontWeight: 600,
                      }}
                    >
                      Allow
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
