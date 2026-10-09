import { useEffect, useRef, useState } from "react";
import type { SessionListItem } from "../preload/preload.js";
import { projectLabel, sessionTitle } from "./format.js";
import { BranchIcon, CloseIcon, GridIcon, PlusIcon } from "./icons.js";
import { RADIUS, SPACE, TEXT } from "./ui.js";
import { StatusLine, type SessionStatus } from "./Sidebar.js";
import TerminalPane from "./TerminalPane.js";

interface TerminalGridProps {
  /** Already filtered to ids still present in openTerminalTabs — a session
   * can close while the grid is showing it. */
  sessionIds: string[];
  openTerminalTabs: { id: string; cwd: string; generation: number; exited: boolean }[];
  sessions: SessionListItem[];
  sessionStatuses: Map<string, SessionStatus>;
  rows: number;
  cols: number;
  onGridSizeChange: (rows: number, cols: number) => void;
  onAddAll: () => void;
  onAddOne: (id: string) => void;
  onEmpty: () => void;
  onRemove: (id: string) => void;
  onReorder: (fromId: string, toId: string) => void;
  onProcessExit: (id: string) => void;
}

const MAX_PICKER_SIZE = 4;

/** A real NxM picker (hover a cell, click to commit — the same interaction every grid-size
 * picker in spreadsheet/table UIs uses) instead of a bare "Columns: 1 2 3 4" control with rows
 * silently auto-derived from however many sessions happened to be added. Rows and columns are
 * now independent and explicit, which is also what makes empty/addable slots (below) possible —
 * a grid can be deliberately sized bigger than what's currently in it. */
function GridSizePicker({ rows, cols, onChange }: { rows: number; cols: number; onChange: (rows: number, cols: number) => void }) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState<{ r: number; c: number } | null>(null);
  const shownR = hover ? hover.r + 1 : rows;
  const shownC = hover ? hover.c + 1 : cols;

  return (
    <div style={{ position: "relative" }}>
      <button onClick={() => setOpen((v) => !v)} style={ghostButtonStyle}>
        <GridIcon size={12} /> {rows}×{cols}
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 10 }} />
          <div
            onMouseLeave={() => setHover(null)}
            style={{
              position: "absolute",
              top: "calc(100% + 4px)",
              left: 0,
              zIndex: 20,
              padding: SPACE.sm,
              background: "var(--color-bg-elevated)",
              border: "1px solid var(--color-border)",
              borderRadius: RADIUS.md,
              boxShadow: "var(--shadow-md)",
            }}
          >
            <div style={{ display: "grid", gridTemplateColumns: `repeat(${MAX_PICKER_SIZE}, 18px)`, gap: 3 }}>
              {Array.from({ length: MAX_PICKER_SIZE }).map((_, r) =>
                Array.from({ length: MAX_PICKER_SIZE }).map((_, c) => (
                  <div
                    key={`${r}-${c}`}
                    onMouseEnter={() => setHover({ r, c })}
                    onClick={() => {
                      onChange(r + 1, c + 1);
                      setOpen(false);
                    }}
                    style={{
                      width: 18,
                      height: 18,
                      borderRadius: 3,
                      cursor: "pointer",
                      background: r <= shownR - 1 && c <= shownC - 1 ? "var(--color-accent)" : "var(--color-bg-hover)",
                      transition: "background 0.08s ease",
                    }}
                  />
                )),
              )}
            </div>
            <div style={{ textAlign: "center", fontSize: TEXT.xs, color: "var(--color-text-muted)", marginTop: 6 }}>
              {shownR} × {shownC}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** An empty-but-addable cell — dashed outline (same visual language as ProjectOverview.tsx's
 * "+ New" worktree card), click to pick which already-open-but-not-in-grid session fills it.
 * Always appends (lands in the next free slot) rather than targeting THIS specific slot
 * position — gridSessionIds has no concept of a gap to target, every empty slot is simply
 * "whatever's past the end of the list right now," so any one of them does the same thing. */
function EmptySlot({ available, sessions, onPick }: { available: { id: string; cwd: string }[]; sessions: SessionListItem[]; onPick: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        border: "1px dashed var(--color-border)",
        borderRadius: RADIUS.md,
        minHeight: 0,
      }}
    >
      <button
        onClick={() => available.length > 0 && setOpen((v) => !v)}
        disabled={available.length === 0}
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 5,
          border: "none",
          background: "transparent",
          color: "var(--color-text-muted)",
          cursor: available.length > 0 ? "pointer" : "default",
          fontSize: TEXT.sm,
        }}
      >
        <PlusIcon size={16} />
        {available.length > 0 ? "Add session" : "No more sessions open"}
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 10 }} />
          <div
            style={{
              position: "absolute",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
              zIndex: 20,
              minWidth: 200,
              maxHeight: 260,
              overflowY: "auto",
              background: "var(--color-bg-elevated)",
              border: "1px solid var(--color-border)",
              borderRadius: RADIUS.md,
              boxShadow: "var(--shadow-md)",
            }}
          >
            {available.map((t) => {
              const session = sessions.find((s) => s.id === t.id);
              return (
                <button
                  key={t.id}
                  onClick={() => {
                    onPick(t.id);
                    setOpen(false);
                  }}
                  className="metaharn-icon-btn"
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    border: "none",
                    borderBottom: "1px solid var(--color-border)",
                    background: "transparent",
                    cursor: "pointer",
                    padding: "8px 12px",
                  }}
                >
                  <div style={{ fontSize: TEXT.sm, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {session ? sessionTitle(session) : "Terminal"}
                  </div>
                  <div style={{ fontSize: TEXT.xs, color: "var(--color-text-muted)" }}>{projectLabel(t.cwd)}</div>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

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
 * rows×cols is now independently set (GridSizePicker above), not rows
 * auto-derived from session count — which is also what makes EmptySlot
 * above meaningful: a grid can be deliberately sized ahead of how many
 * sessions are in it yet, with visible addable gaps instead of silently
 * having no concept of "bigger than what's currently placed."  Columns
 * are still individually resizable (drag the dividers); rows split evenly
 * — full independent per-row resize would need a 2D size grid instead of
 * one 1D array, out of scope for v0, equal row heights read fine in
 * practice for a handful of terminal panes.
 */
export default function TerminalGrid({
  sessionIds,
  openTerminalTabs,
  sessions,
  sessionStatuses,
  rows,
  cols,
  onGridSizeChange,
  onAddAll,
  onAddOne,
  onEmpty,
  onRemove,
  onReorder,
  onProcessExit,
}: TerminalGridProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [colSizes, setColSizes] = useState<number[]>(() => Array(cols).fill(1));
  const [resizingCol, setResizingCol] = useState<number | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [branchByCwd, setBranchByCwd] = useState<Map<string, string | null>>(new Map());

  useEffect(() => {
    setColSizes(Array(cols).fill(1));
  }, [cols]);

  // Real `git branch --show-current` per distinct cwd shown right now — same pattern
  // ProjectOverview.tsx/ProjectsListPage.tsx already use, never a guessed label.
  const shownIds = sessionIds.slice(0, rows * cols);
  const cwds = [...new Set(shownIds.map((id) => openTerminalTabs.find((t) => t.id === id)?.cwd).filter((c): c is string => Boolean(c)))];
  const cwdKey = cwds.join(",");
  useEffect(() => {
    let cancelled = false;
    Promise.all(cwds.map((cwd) => window.metaharnFiles.getGitBranch(cwd).then((b) => [cwd, b] as const))).then((results) => {
      if (cancelled) return;
      setBranchByCwd(new Map(results));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwdKey]);

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

  const availableToAdd = openTerminalTabs.filter((t) => !sessionIds.includes(t.id));

  const controls = (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: SPACE.sm, flexShrink: 0 }}>
      <GridSizePicker rows={rows} cols={cols} onChange={onGridSizeChange} />
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

  if (sessionIds.length === 0 && availableToAdd.length === 0) {
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
          <span>Open a few terminal sessions, then add them to the grid to view side by side.</span>
        </div>
      </div>
    );
  }

  const totalSlots = Math.max(rows * cols, shownIds.length);
  const emptySlotCount = Math.max(0, totalSlots - shownIds.length);

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
        {shownIds.map((id) => {
          const tab = openTerminalTabs.find((t) => t.id === id);
          const session = sessions.find((s) => s.id === id);
          if (!tab) return null;
          const branch = branchByCwd.get(tab.cwd);
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
                boxShadow: "var(--shadow-sm)",
                overflow: "hidden",
              }}
            >
              {/* "project / title   branch ● status" on one line — the old header was just a
                  bare mono session title, no project/branch/status at all, which read as "a
                  stripped-down terminal tab strip" rather than a real session card (every OTHER
                  session surface in this app — the sidebar, ProjectOverview — already shows all
                  three). */}
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
                  padding: "6px 8px",
                  background: "var(--color-bg-secondary)",
                  borderBottom: "1px solid var(--color-border)",
                  cursor: "grab",
                  flexShrink: 0,
                  minWidth: 0,
                }}
              >
                <span style={{ display: "flex", alignItems: "baseline", gap: 5, minWidth: 0, overflow: "hidden" }}>
                  <span style={{ fontSize: TEXT.xs, color: "var(--color-text-muted)", flexShrink: 0 }}>{projectLabel(tab.cwd)} /</span>
                  <span
                    style={{
                      fontSize: TEXT.sm,
                      fontWeight: 600,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      fontFamily: '"IBM Plex Mono", Menlo, Monaco, monospace',
                    }}
                  >
                    {session ? sessionTitle(session) : "Terminal"}
                  </span>
                </span>
                <span style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0, fontSize: TEXT.xs }}>
                  {branch && (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 3, color: "var(--color-text-muted)" }}>
                      <BranchIcon size={10} />
                      {branch}
                    </span>
                  )}
                  <StatusLine status={session ? sessionStatuses.get(session.path) : undefined} fallback="idle" />
                  <button
                    onClick={() => onRemove(id)}
                    aria-label="Remove from grid"
                    className="metaharn-icon-btn metaharn-tooltip"
                    style={{
                      display: "flex",
                      border: "none",
                      background: "transparent",
                      color: "var(--color-text-muted)",
                      cursor: "pointer",
                      padding: 3,
                      borderRadius: RADIUS.sm,
                    }}
                  >
                    <CloseIcon size={12} />
                  </button>
                </span>
              </div>
              <div style={{ flex: 1, minHeight: 0 }}>
                <TerminalPane cwd={tab.cwd} terminalSessionId={id} visible={true} onProcessExit={() => onProcessExit(id)} />
              </div>
            </div>
          );
        })}

        {Array.from({ length: emptySlotCount }).map((_, i) => (
          <EmptySlot key={`empty-${i}`} available={availableToAdd} sessions={sessions} onPick={onAddOne} />
        ))}

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
