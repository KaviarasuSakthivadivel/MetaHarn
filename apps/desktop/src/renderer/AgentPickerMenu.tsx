import type { AgentInfo, AgentKind } from "../preload/preload.js";

interface AgentPickerMenuProps {
  agents: AgentInfo[];
  onPick: (kind: AgentKind) => void;
  onClose: () => void;
}

/** Anchored popover for choosing which real CLI agent a new terminal
 * session should run — only shown at all when more than one is installed
 * (see ProjectOverview.tsx's click handler); a single-agent machine skips
 * this entirely. Matches SessionTreeView/ContextWindowPanel's existing
 * popover pattern: a full-page click-catcher backdrop closes it, not a
 * modal. */
export default function AgentPickerMenu({ agents, onPick, onClose }: AgentPickerMenuProps) {
  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 9 }} />
      <div
        style={{
          position: "absolute",
          top: "100%",
          left: 0,
          marginTop: 4,
          zIndex: 10,
          background: "var(--color-bg)",
          border: "1px solid var(--color-border)",
          borderRadius: 8,
          boxShadow: "0 4px 16px rgba(0, 0, 0, 0.15)",
          minWidth: 160,
          overflow: "hidden",
        }}
      >
        {agents.map((agent) => (
          <button
            key={agent.kind}
            onClick={() => onPick(agent.kind)}
            style={{
              display: "block",
              width: "100%",
              textAlign: "left",
              padding: "8px 12px",
              border: "none",
              background: "transparent",
              color: "var(--color-text)",
              cursor: "pointer",
              fontSize: 13,
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--color-bg-hover)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            {agent.displayName}
          </button>
        ))}
      </div>
    </>
  );
}
