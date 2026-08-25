import type { SessionListItem } from "../preload/preload.js";
import { projectLabel, sessionTitle } from "./format.js";

interface DependencyMenuProps {
  candidates: SessionListItem[];
  anchorRect: DOMRect;
  onPick: (target: SessionListItem) => void;
  onClose: () => void;
}

/**
 * "Set dependency" popover — matches AgentSwapMenu.tsx's anchored-popover
 * pattern, but `position: fixed` off a measured `anchorRect` rather than
 * `position: absolute` off a relative parent: its trigger lives inside
 * Sidebar's `overflowY: auto` session list, which would otherwise clip an
 * absolutely-positioned popover taller/wider than the scroll container.
 *
 * Records a purely visual "this session's work relates to that one"
 * annotation in the minimap — never touches git (see
 * packages/db/src/schema.ts's sessionDependencies doc comment).
 */
export default function DependencyMenu({ candidates, anchorRect, onPick, onClose }: DependencyMenuProps) {
  const top = anchorRect.bottom + 4;
  const left = Math.min(anchorRect.left, window.innerWidth - 260);

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 19 }} />
      <div
        style={{
          position: "fixed",
          top,
          left,
          zIndex: 20,
          width: 240,
          maxHeight: 320,
          overflowY: "auto",
          background: "var(--color-bg)",
          border: "1px solid var(--color-border)",
          borderRadius: 8,
          boxShadow: "0 4px 16px rgba(0, 0, 0, 0.15)",
        }}
      >
        <div style={{ padding: "8px 10px 6px", fontSize: 11, fontWeight: 700, letterSpacing: 0.5, color: "var(--color-text-muted)" }}>
          DEPENDS ON…
        </div>
        {candidates.length === 0 && (
          <div style={{ padding: "4px 10px 10px", fontSize: 12, color: "var(--color-text-muted)" }}>
            No other sessions yet.
          </div>
        )}
        {candidates.map((c) => (
          <button
            key={c.path}
            onClick={() => onPick(c)}
            className="metaharn-icon-btn"
            style={{
              display: "block",
              width: "100%",
              textAlign: "left",
              border: "none",
              background: "transparent",
              padding: "6px 10px",
              cursor: "pointer",
              color: "var(--color-text)",
            }}
          >
            <div style={{ fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {sessionTitle(c)}
            </div>
            <div style={{ fontSize: 10.5, color: "var(--color-text-muted)" }}>{projectLabel(c.cwd)}</div>
          </button>
        ))}
      </div>
    </>
  );
}
