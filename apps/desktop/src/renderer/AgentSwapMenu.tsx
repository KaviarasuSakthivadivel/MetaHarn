import type { AgentKind } from "../preload/preload.js";
import { DownloadIcon } from "./icons.js";
import { ALL_AGENT_KINDS, AGENT_DISPLAY_NAMES } from "./format.js";

interface AgentSwapMenuProps {
  currentKind: AgentKind;
  installedKinds: AgentKind[];
  onSwap: (kind: AgentKind) => void;
  onGoToInstall: () => void;
  onClose: () => void;
}

/**
 * Swaps which real CLI agent is running in THIS terminal session, in
 * place — distinct from the agent picker on session *creation*
 * (ProjectOverview.tsx's AgentPickerMenu). A `{agent} ⌄` dropdown in the
 * session header. Swapping ends the current agent's live process and conversation for this
 * tab (a different CLI has no way to inherit another one's context) — the
 * caller confirms before calling onSwap.
 */
export default function AgentSwapMenu({ currentKind, installedKinds, onSwap, onGoToInstall, onClose }: AgentSwapMenuProps) {
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
          const isCurrent = kind === currentKind;
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
                onClick={() => {
                  if (isCurrent) return;
                  if (isInstalled) onSwap(kind);
                }}
                disabled={isCurrent || !isInstalled}
                style={{
                  flex: 1,
                  textAlign: "left",
                  border: "none",
                  background: "transparent",
                  color: isInstalled ? "var(--color-text)" : "var(--color-text-muted)",
                  cursor: isCurrent || !isInstalled ? "default" : "pointer",
                  fontSize: 13,
                  padding: 0,
                }}
              >
                {isCurrent ? `${label} (current)` : isInstalled ? `Swap to ${label}` : label}
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
