import { useState } from "react";
import type { RootDir, TodoItem } from "./client.js";

function IconChevron({ open }: { open: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" style={{ transform: open ? "rotate(90deg)" : undefined, transition: "transform 100ms ease" }}>
      <polyline points="9 6 15 12 9 18" />
    </svg>
  );
}

function Section({ title, defaultOpen = true, right, children }: { title: string; defaultOpen?: boolean; right?: React.ReactNode; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="session-panel-section">
      <button className="session-panel-section-header" onClick={() => setOpen((o) => !o)}>
        <IconChevron open={open} />
        <span className="session-panel-section-title">{title}</span>
        {right && <span className="session-panel-section-right">{right}</span>}
      </button>
      {open && <div className="session-panel-section-body">{children}</div>}
    </div>
  );
}

function TodoRow({ item }: { item: TodoItem }) {
  const icon = item.status === "done" ? "☑" : item.status === "in_progress" ? "◉" : "☐";
  return (
    <div className={`todo-row todo-${item.status}`}>
      <span className="todo-icon">{icon}</span>
      <span className="todo-text">{item.content}</span>
    </div>
  );
}

export default function SessionPanel({
  todos,
  roots,
  toolCallCount,
  webSearchEnabled,
  onGrantFolder,
  onRevokeFolder,
  onToggleWebSearch,
  onClose,
}: {
  todos: TodoItem[];
  roots: RootDir[];
  toolCallCount: number;
  webSearchEnabled: boolean;
  onGrantFolder: (path: string, writable: boolean) => void;
  onRevokeFolder: (path: string) => void;
  onToggleWebSearch: (enabled: boolean) => void;
  onClose: () => void;
}) {
  const [newPath, setNewPath] = useState("");
  const [newWritable, setNewWritable] = useState(false);

  function submitGrant() {
    if (!newPath.trim()) return;
    onGrantFolder(newPath.trim(), newWritable);
    setNewPath("");
    setNewWritable(false);
  }

  return (
    <aside className="session-panel">
      <div className="session-panel-top">
        <span className="session-panel-title">Session</span>
        <button className="btn-ghost" onClick={onClose}>
          Close
        </button>
      </div>

      <Section title="Progress">
        {todos.length === 0 ? (
          <p className="session-panel-empty">No plan yet — one appears once the agent calls todo_write.</p>
        ) : (
          <>
            {todos.map((t, i) => (
              <TodoRow key={i} item={t} />
            ))}
            <div className="session-panel-footnote">{toolCallCount} tool call{toolCallCount === 1 ? "" : "s"} so far</div>
          </>
        )}
      </Section>

      <Section title="Access" right={<span className="session-panel-hint">{roots.length} folder{roots.length === 1 ? "" : "s"}</span>}>
        <div className="access-sources-label">Sources</div>
        <div className="access-source-row">
          <span>Web search</span>
          <button className={`switch${webSearchEnabled ? " on" : ""}`} aria-label="Toggle web search" onClick={() => onToggleWebSearch(!webSearchEnabled)} />
        </div>
        <div className="access-folders-label">Folders</div>
        {roots.map((r, i) => (
          <div className="access-folder-row" key={r.path}>
            <div className="access-folder-main">
              <div className="access-folder-name">{r.label}</div>
              <div className="access-folder-path">{r.path}</div>
            </div>
            <span className={`access-pill ${r.writable ? "rw" : "ro"}`}>{r.writable ? "Read-write" : "Read-only"}</span>
            {i >= 2 && (
              <button className="access-folder-remove" aria-label={`Revoke access to ${r.label}`} onClick={() => onRevokeFolder(r.path)}>
                ×
              </button>
            )}
          </div>
        ))}
        <div className="access-grant-form">
          <input placeholder="/path/to/folder" value={newPath} onChange={(e) => setNewPath(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submitGrant()} />
          <label className="access-grant-checkbox">
            <input type="checkbox" checked={newWritable} onChange={(e) => setNewWritable(e.target.checked)} />
            Read-write
          </label>
          <button className="btn-sm" onClick={submitGrant} disabled={!newPath.trim()}>
            + Give access
          </button>
        </div>
      </Section>
    </aside>
  );
}
