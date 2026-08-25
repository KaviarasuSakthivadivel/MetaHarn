import type { AgentKind } from "../preload/preload.js";
import { DownloadIcon } from "./icons.js";
import { ALL_AGENT_KINDS, AGENT_DISPLAY_NAMES } from "./format.js";

interface AgentPickerMenuProps {
  installedKinds: AgentKind[];
  onPick: (kind: AgentKind) => void;
  onGoToInstall: () => void;
  onClose: () => void;
}

/** Anchored popover for choosing which real CLI agent a new terminal
 * session should run. Lists all known agent kinds, not just installed
 * ones — same pattern as AgentSwapMenu.tsx's existing-session equivalent
 * (a not-installed kind is greyed out with an Install link to Settings,
 * rather than silently never appearing here at all). Matches
 * SessionTreeView/ContextWindowPanel's existing popover pattern: a
 * full-page click-catcher backdrop closes it, not a modal. */
export default function AgentPickerMenu({ installedKinds, onPick, onGoToInstall, onClose }: AgentPickerMenuProps) {
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
          minWidth: 200,
          overflow: "hidden",
        }}
      >
        {ALL_AGENT_KINDS.map((kind) => {
          const label = AGENT_DISPLAY_NAMES[kind];
          const isInstalled = installedKinds.includes(kind);
          return (
            <div
              key={kind}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                padding: "8px 12px",
              }}
            >
              <button
                onClick={() => isInstalled && onPick(kind)}
                disabled={!isInstalled}
                style={{
                  flex: 1,
                  textAlign: "left",
                  border: "none",
                  background: "transparent",
                  color: isInstalled ? "var(--color-text)" : "var(--color-text-muted)",
                  cursor: isInstalled ? "pointer" : "default",
                  fontSize: 13,
                  padding: 0,
                }}
                onMouseEnter={(e) => isInstalled && (e.currentTarget.style.background = "var(--color-bg-hover)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                {label}
              </button>
              {!isInstalled && (
                <button
                  onClick={onGoToInstall}
                  title="Install from Settings"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                    border: "none",
                    background: "transparent",
                    color: "var(--color-accent)",
                    cursor: "pointer",
                    fontSize: 12,
                    padding: 0,
                    flexShrink: 0,
                  }}
                >
                  <DownloadIcon size={13} /> Install
                </button>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
