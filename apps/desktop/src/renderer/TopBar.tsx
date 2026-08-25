import { AppMark } from "./icons.js";

// -webkit-app-region isn't in React's CSSProperties typings, but it's a
// real, standard Electron/WebKit style property at runtime.
const dragRegion = (region: "drag" | "no-drag"): React.CSSProperties =>
  ({ WebkitAppRegion: region }) as React.CSSProperties;

interface TopBarProps {
  onBrandClick: () => void;
  onNewProject: () => void;
  onOpenSettings: () => void;
  settingsActive?: boolean;
}

export default function TopBar({ onBrandClick, onNewProject, onOpenSettings, settingsActive }: TopBarProps) {
  return (
    <header
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        height: 48,
        flexShrink: 0,
        // Left padding clears macOS's traffic-light buttons, which float
        // over the content instead of sitting in their own native strip
        // now that the window uses titleBarStyle: "hiddenInset". main.ts
        // pins trafficLightPosition to {x: 16, y: 16} explicitly, so this
        // is a known clearance (16px start + ~54px button group + 20px
        // breathing room), not a guess at macOS's OS-version-dependent
        // default placement — an earlier guess (76px) left the brand text
        // sitting uncomfortably close to the buttons. The whole bar is the
        // window's drag handle (no native title bar left to grab
        // otherwise) — every interactive element inside opts back out.
        padding: "0 12px 0 90px",
        borderBottom: "1px solid var(--color-border)",
        background: "var(--color-bg-secondary)",
        ...dragRegion("drag"),
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
        <button
          onClick={onBrandClick}
          title="Back to all projects"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            color: "var(--color-accent)",
            fontSize: 15,
            fontWeight: 700,
            background: "transparent",
            border: "none",
            padding: 0,
            cursor: "pointer",
            ...dragRegion("no-drag"),
          }}
        >
          <AppMark size={18} />
          MetaHarn
        </button>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, ...dragRegion("no-drag") }}>
        <button
          onClick={onNewProject}
          aria-label="New project"
          className="metaharn-tooltip"
          style={{
            border: "1px solid var(--color-border)",
            borderRadius: 6,
            background: "transparent",
            color: "var(--color-text)",
            cursor: "pointer",
            width: 28,
            height: 28,
            lineHeight: 1,
          }}
        >
          +
        </button>
        <button
          onClick={onOpenSettings}
          aria-label="Settings"
          className="metaharn-tooltip"
          style={{
            border: "1px solid var(--color-border)",
            borderRadius: 6,
            background: settingsActive ? "var(--color-bg-hover)" : "transparent",
            color: "var(--color-text)",
            cursor: "pointer",
            width: 28,
            height: 28,
            lineHeight: 1,
          }}
        >
          ⚙
        </button>
      </div>
    </header>
  );
}
