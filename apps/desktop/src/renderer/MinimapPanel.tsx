import type { SessionDependency, SessionListItem } from "../preload/preload.js";
import { projectLabel, sessionTitle } from "./format.js";
import { LinkIcon } from "./icons.js";

interface MinimapPanelProps {
  sessions: SessionListItem[];
  dependencies: SessionDependency[];
  anchorRect: DOMRect;
  onRemove: (dep: SessionDependency) => void;
  onClose: () => void;
}

function findSession(sessions: SessionListItem[], id: string): SessionListItem | undefined {
  return sessions.find((s) => s.id === id);
}

/**
 * The minimap: every recorded dependency edge, as a simple indented list —
 * intentionally NOT a canvas-drawn graph, same "simple list over a visual
 * graph" call SessionTreeView.tsx already made for v0. Edges where either
 * endpoint no longer resolves to a known session (deleted since) are
 * silently dropped rather than shown broken — there's no cascade-delete on
 * session removal (see catalog.ts), so this is where that gets cleaned up
 * visually instead.
 */
export default function MinimapPanel({ sessions, dependencies, anchorRect, onRemove, onClose }: MinimapPanelProps) {
  const grouped = new Map<string, SessionDependency[]>();
  for (const dep of dependencies) {
    if (!findSession(sessions, dep.sessionId) || !findSession(sessions, dep.dependsOnSessionId)) continue;
    const list = grouped.get(dep.sessionId) ?? [];
    list.push(dep);
    grouped.set(dep.sessionId, list);
  }

  const top = anchorRect.bottom + 4;
  const left = Math.min(anchorRect.left, window.innerWidth - 300);

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 19 }} />
      <div
        style={{
          position: "fixed",
          top,
          left,
          zIndex: 20,
          width: 280,
          maxHeight: 360,
          overflowY: "auto",
          background: "var(--color-bg)",
          border: "1px solid var(--color-border)",
          borderRadius: 8,
          boxShadow: "0 4px 16px rgba(0, 0, 0, 0.15)",
          padding: "8px 0",
        }}
      >
        <div style={{ padding: "0 12px 8px", fontSize: 11, fontWeight: 700, letterSpacing: 0.5, color: "var(--color-text-muted)" }}>
          SESSION DEPENDENCIES
        </div>
        {grouped.size === 0 && (
          <div style={{ padding: "0 12px 10px", fontSize: 12, color: "var(--color-text-muted)", lineHeight: 1.5 }}>
            No dependencies set yet. Hover a session and use the link icon to
            record one — visual only, never touches git.
          </div>
        )}
        {[...grouped.entries()].map(([sessionId, deps]) => {
          const source = findSession(sessions, sessionId);
          if (!source) return null;
          return (
            <div key={sessionId} style={{ padding: "5px 12px" }}>
              <div style={{ fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {sessionTitle(source)}
              </div>
              {deps.map((dep) => {
                const target = findSession(sessions, dep.dependsOnSessionId);
                if (!target) return null;
                return (
                  <div
                    key={dep.dependsOnSessionId}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 6,
                      paddingLeft: 16,
                      marginTop: 3,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0, fontSize: 11.5, color: "var(--color-text-secondary)" }}>
                      <span style={{ color: "var(--color-text-muted)", flexShrink: 0 }}>
                        <LinkIcon size={11} />
                      </span>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {sessionTitle(target)}{" "}
                        <span style={{ color: "var(--color-text-muted)" }}>({projectLabel(target.cwd)})</span>
                      </span>
                    </div>
                    <button
                      onClick={() => onRemove(dep)}
                      aria-label="Remove dependency"
                      className="metaharn-tooltip"
                      style={{
                        flexShrink: 0,
                        border: "none",
                        background: "transparent",
                        color: "var(--color-text-muted)",
                        cursor: "pointer",
                        fontSize: 11,
                        padding: "0 4px",
                      }}
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </>
  );
}
