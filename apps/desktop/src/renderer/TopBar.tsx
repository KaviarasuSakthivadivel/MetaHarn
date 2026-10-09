import { AppMark, BarChartIcon, BellIcon, DollarIcon, GearIcon, PlusIcon } from "./icons.js";

// -webkit-app-region isn't in React's CSSProperties typings, but it's a
// real, standard Electron/WebKit style property at runtime.
const dragRegion = (region: "drag" | "no-drag"): React.CSSProperties =>
  ({ WebkitAppRegion: region }) as React.CSSProperties;

interface TopBarProps {
  onBrandClick: () => void;
  onNewProject: () => void;
  onOpenSettings: () => void;
  settingsActive?: boolean;
  onOpenInbox: () => void;
  inboxActive?: boolean;
  pendingInboxCount: number;
  onOpenUsageCosts: () => void;
  usageActive?: boolean;
  onOpenWeeklyRewind: () => void;
  weeklyRewindActive?: boolean;
}

export default function TopBar({
  onBrandClick,
  onNewProject,
  onOpenSettings,
  settingsActive,
  onOpenInbox,
  inboxActive,
  pendingInboxCount,
  onOpenUsageCosts,
  usageActive,
  onOpenWeeklyRewind,
  weeklyRewindActive,
}: TopBarProps) {
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
        boxShadow: "var(--shadow-sm)",
        position: "relative",
        zIndex: 1,
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

      <div style={{ display: "flex", alignItems: "center", gap: 6, ...dragRegion("no-drag") }}>
        <button
          onClick={onNewProject}
          aria-label="New project"
          className="metaharn-icon-btn metaharn-tooltip"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "1px solid var(--color-border)",
            borderRadius: 8,
            background: "transparent",
            color: "var(--color-text-secondary)",
            cursor: "pointer",
            width: 30,
            height: 30,
          }}
        >
          <PlusIcon size={15} />
        </button>
        <button
          onClick={onOpenUsageCosts}
          aria-label="Usage & Estimated Costs"
          className="metaharn-icon-btn metaharn-tooltip"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "1px solid var(--color-border)",
            borderRadius: 8,
            background: usageActive ? "var(--color-bg-hover)" : "transparent",
            color: usageActive ? "var(--color-accent)" : "var(--color-text-secondary)",
            cursor: "pointer",
            width: 30,
            height: 30,
          }}
        >
          <DollarIcon size={15} />
        </button>
        <button
          onClick={onOpenWeeklyRewind}
          aria-label="Weekly Rewind"
          className="metaharn-icon-btn metaharn-tooltip"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "1px solid var(--color-border)",
            borderRadius: 8,
            background: weeklyRewindActive ? "var(--color-bg-hover)" : "transparent",
            color: weeklyRewindActive ? "var(--color-accent)" : "var(--color-text-secondary)",
            cursor: "pointer",
            width: 30,
            height: 30,
          }}
        >
          <BarChartIcon size={15} />
        </button>
        <button
          onClick={onOpenInbox}
          aria-label="Inbox"
          className="metaharn-icon-btn metaharn-tooltip"
          style={{
            position: "relative",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "1px solid var(--color-border)",
            borderRadius: 8,
            background: inboxActive ? "var(--color-bg-hover)" : "transparent",
            color: inboxActive ? "var(--color-accent)" : "var(--color-text-secondary)",
            cursor: "pointer",
            width: 30,
            height: 30,
          }}
        >
          <BellIcon size={15} />
          {pendingInboxCount > 0 && (
            <span
              style={{
                position: "absolute",
                top: -4,
                right: -4,
                minWidth: 15,
                height: 15,
                padding: "0 3px",
                borderRadius: 999,
                background: "var(--color-accent)",
                color: "#fff",
                fontSize: 10,
                fontWeight: 700,
                lineHeight: "15px",
                textAlign: "center",
                boxShadow: "0 0 0 2px var(--color-bg-secondary)",
              }}
            >
              {pendingInboxCount > 9 ? "9+" : pendingInboxCount}
            </span>
          )}
        </button>
        <button
          onClick={onOpenSettings}
          aria-label="Settings"
          className="metaharn-icon-btn metaharn-tooltip"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "1px solid var(--color-border)",
            borderRadius: 8,
            background: settingsActive ? "var(--color-bg-hover)" : "transparent",
            color: settingsActive ? "var(--color-accent)" : "var(--color-text-secondary)",
            cursor: "pointer",
            width: 30,
            height: 30,
          }}
        >
          <GearIcon size={15} />
        </button>
      </div>
    </header>
  );
}
