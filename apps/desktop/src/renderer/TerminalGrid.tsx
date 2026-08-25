import { useEffect, useRef, useState } from "react";
import type { SessionListItem } from "../preload/preload.js";
import { sessionTitle } from "./format.js";
import { PlusIcon } from "./icons.js";
import { RADIUS, SegmentedControl, SPACE, TEXT } from "./ui.js";
import TerminalPane from "./TerminalPane.js";

interface TerminalGridProps {
  /** Already filtered to ids still present in openTerminalTabs — a session
   * can close while the grid is showing it. */
  sessionIds: string[];
  openTerminalTabs: { id: string; cwd: string; generation: number; exited: boolean }[];
  sessions: SessionListItem[];
  cols: number;
  onColsChange: (cols: number) => void;
  onAddAll: () => void;
  onEmpty: () => void;
  onRemove: (id: string) => void;
  onReorder: (fromId: string, toId: string) => void;
  onProcessExit: (id: string) => void;
}

const COL_OPTIONS = [1, 2, 3, 4] as const;

/**
 * A second, independent way to view a SUBSET of already-open terminal
 * sessions simultaneously — replaces the single-tab view while showing,
 * doesn't sit alongside it (see App.tsx's render, which force-hides the
 * single-view panes while this is up).
 *
 * Real trade-off, stated plainly rather than hidden: each session placed
 * here gets its OWN `<TerminalPane>` instance, separate from the single-
 * tab view's instance for the same id. This is safe — `metaharnPty.create`
 * is attach-or-create (never spawns a second pty for the same session id)
 * and `metaharnPty.onData`/`onExit` broadcast to every subscriber, so both
 * instances independently render the same real output stream — but it
 * DOES mean each instance keeps its own client-side xterm.js scrollback
 * buffer. Moving a session between the grid and the single-tab view
 * (or just toggling the grid on/off) unmounts one instance and mounts a
 * fresh one. That fresh instance is seeded with the pty's real current
 * buffer via `metaharnPty.create`'s `scrollback` reply (see pty-ipc.ts) before
 * it goes live, so it shows the actual current terminal state immediately —
 * it used to start genuinely blank until new output happened to arrive,
 * which looked "stuck" for any session idling at its own prompt. The real
 * pty process and anything the CLI's own resumable transcript captured were
 * never affected either way, only what a freshly-mounted client rendered.
 * A portal-based single shared instance would remove the two-scrollback-
 * buffers trade-off entirely but isn't a small change, so not done here.
 *
 * Columns are individually resizable (drag the dividers); rows split
 * evenly. Full independent per-row resize would need a 2D size grid
 * instead of one 1D array — out of scope for v0, equal row heights read
 * fine in practice for a handful of terminal panes.
 */
export default function TerminalGrid({
  sessionIds,
  openTerminalTabs,
  sessions,
  cols,
  onColsChange,
  onAddAll,
  onEmpty,
  onRemove,
  onReorder,
  onProcessExit,
}: TerminalGridProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [colSizes, setColSizes] = useState<number[]>(() => Array(cols).fill(1));
  const [resizingCol, setResizingCol] = useState<number | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);

  useEffect(() => {
    setColSizes(Array(cols).fill(1));
  }, [cols]);

  useEffect(() => {
    if (resizingCol === null) return;
    const onMouseMove = (e: MouseEvent) => {
      const containerWidth = containerRef.current?.clientWidth ?? 1;
      setColSizes((prev) => {
        const totalFr = prev.reduce((a, b) => a + b, 0);
        const deltaFr = (e.movementX / containerWidth) * totalFr;
        const minFr = totalFr * 0.1;
        const next = [...prev];
        next[resizingCol] = Math.max(minFr, next[resizingCol] + deltaFr);
        next[resizingCol + 1] = Math.max(minFr, next[resizingCol + 1] - deltaFr);
        return next;
      });
    };
    const onMouseUp = () => setResizingCol(null);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [resizingCol]);

  const controls = (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: SPACE.sm, flexShrink: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: SPACE.sm }}>
        <span style={{ fontSize: TEXT.xs, color: "var(--color-text-muted)" }}>Columns</span>
        <SegmentedControl
          options={COL_OPTIONS.map((n) => ({ value: String(n), label: String(n) }))}
          value={String(cols)}
          onChange={(v) => onColsChange(Number(v))}
        />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: SPACE.sm }}>
        <button onClick={onAddAll} style={ghostButtonStyle}>
          <PlusIcon size={12} /> Add all
        </button>
        <button onClick={onEmpty} style={ghostButtonStyle}>
          Empty grid
        </button>
      </div>
    </div>
  );

  if (sessionIds.length === 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
        {controls}
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: SPACE.sm,
            border: "1px dashed var(--color-border)",
            borderRadius: RADIUS.md,
            color: "var(--color-text-muted)",
            fontSize: TEXT.base,
          }}
        >
          <span>Add sessions to the grid to view them side by side.</span>
          {openTerminalTabs.length > 0 && (
            <button onClick={onAddAll} className="metaharn-btn-primary" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <PlusIcon size={13} /> Add all open sessions
            </button>
          )}
        </div>
      </div>
    );
  }

  const rows = Math.ceil(sessionIds.length / cols);

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {controls}
      <div
        ref={containerRef}
        style={{
          flex: 1,
          minHeight: 0,
          display: "grid",
          gridTemplateColumns: colSizes.map((s) => `${s}fr`).join(" "),
          gridTemplateRows: `repeat(${rows}, 1fr)`,
          gap: SPACE.sm,
          position: "relative",
        }}
      >
        {sessionIds.map((id) => {
          const tab = openTerminalTabs.find((t) => t.id === id);
          const session = sessions.find((s) => s.id === id);
          if (!tab) return null;
          return (
            <div
              key={id}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (draggedId && draggedId !== id) onReorder(draggedId, id);
                setDraggedId(null);
              }}
              style={{
                display: "flex",
                flexDirection: "column",
                minWidth: 0,
                minHeight: 0,
                border: "1px solid var(--color-border)",
                borderRadius: RADIUS.md,
                overflow: "hidden",
              }}
            >
              <div
                draggable
                onDragStart={(e) => {
                  setDraggedId(id);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragEnd={() => setDraggedId(null)}
                title="Drag to swap with another pane"
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: SPACE.sm,
                  padding: "4px 8px",
                  background: "var(--color-bg-secondary)",
                  borderBottom: "1px solid var(--color-border)",
                  cursor: "grab",
                  flexShrink: 0,
                }}
              >
                <span
                  style={{
                    fontSize: TEXT.xs,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontFamily: '"IBM Plex Mono", Menlo, Monaco, monospace',
                  }}
                >
                  {session ? sessionTitle(session) : "Terminal"}
                </span>
                <button
                  onClick={() => onRemove(id)}
                  aria-label="Remove from grid"
                  className="metaharn-tooltip"
                  style={{
                    flexShrink: 0,
                    border: "none",
                    background: "transparent",
                    color: "var(--color-text-muted)",
                    cursor: "pointer",
                    fontSize: 13,
                    lineHeight: 1,
                    padding: "0 2px",
                  }}
                >
                  ×
                </button>
              </div>
              <div style={{ flex: 1, minHeight: 0 }}>
                <TerminalPane cwd={tab.cwd} terminalSessionId={id} visible={true} onProcessExit={() => onProcessExit(id)} />
              </div>
            </div>
          );
        })}

        {/* Column-resize dividers — N-1 thin draggable strips positioned at
            each running fraction boundary, same technique as App.tsx's
            sidebar resize handle, generalized to multiple dividers. */}
        {colSizes.slice(0, -1).map((_, i) => {
          const totalFr = colSizes.reduce((a, b) => a + b, 0);
          const leftFr = colSizes.slice(0, i + 1).reduce((a, b) => a + b, 0);
          const leftPercent = (leftFr / totalFr) * 100;
          return (
            <div
              key={i}
              onMouseDown={(e) => {
                e.preventDefault();
                setResizingCol(i);
              }}
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                left: `calc(${leftPercent}% - 3px)`,
                width: 6,
                cursor: "col-resize",
                background: resizingCol === i ? "var(--color-accent)" : "transparent",
                zIndex: 1,
              }}
              className="metaharn-resize-handle"
            />
          );
        })}
      </div>
    </div>
  );
}

const ghostButtonStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  border: "1px solid var(--color-border)",
  borderRadius: RADIUS.sm,
  background: "transparent",
  color: "var(--color-text-secondary)",
  cursor: "pointer",
  padding: "4px 9px",
  fontSize: TEXT.xs,
};
