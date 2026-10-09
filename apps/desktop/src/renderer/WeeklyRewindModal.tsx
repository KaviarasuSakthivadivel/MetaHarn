import { useEffect, useState, type ReactNode } from "react";
import type { WeeklyRewind } from "../preload/preload.js";
import { RADIUS, SPACE, TEXT } from "./ui.js";
import { ActivityIcon, CalendarIcon, ClockIcon, CloseIcon, DollarIcon, FolderIcon, ZapIcon } from "./icons.js";
import { StatTile, BarChart, ActivityHeatmap } from "./UsageCharts.js";

const MONO = '"IBM Plex Mono", Menlo, Monaco, monospace';
const DOW_SHORT = ["M", "T", "W", "T", "F", "S", "S"];

function formatMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}
function formatUsd(v: number): string {
  return `$${v.toFixed(2)}`;
}
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
function sessionCount(n: number): string {
  return `${n} session${n === 1 ? "" : "s"}`;
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ border: "1px solid var(--color-border)", borderRadius: RADIUS.lg, background: "var(--color-bg-elevated)", boxShadow: "var(--shadow-sm)", padding: SPACE.lg, minWidth: 0 }}>
      <div style={{ fontSize: TEXT.base, fontWeight: 600, marginBottom: SPACE.md }}>{title}</div>
      {children}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: TEXT.sm, color: "var(--color-text-muted)", padding: `${SPACE.lg}px 0`, textAlign: "center" }}>{children}</div>;
}

function iconBtnStyle(size: number): React.CSSProperties {
  return { display: "flex", alignItems: "center", justifyContent: "center", width: size, height: size, border: "none", borderRadius: RADIUS.md, background: "transparent", color: "var(--color-text-secondary)", cursor: "pointer" };
}

export default function WeeklyRewindModal({ onClose }: { onClose: () => void }) {
  const [weekStart, setWeekStart] = useState<string | undefined>(undefined);
  const [data, setData] = useState<WeeklyRewind | null>(null);
  // A rejected IPC call with no .catch() here previously just left `data` null forever — the
  // "Loading…" state below never had a failure branch to fall into, so a real error (e.g. the
  // handler not being registered yet after a dev-server restart) looked identical to "still
  // fetching" with nothing in the UI to tell them apart.
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    window.metaharn
      .getWeeklyRewind(weekStart)
      .then(setData)
      .catch((err: Error) => setError(err.message));
  }, [weekStart]);

  const shiftWeek = (deltaDays: number) => {
    const base = new Date(`${data?.weekStart ?? weekStart ?? new Date().toISOString().slice(0, 10)}T00:00:00`);
    base.setDate(base.getDate() + deltaDays);
    setWeekStart(base.toISOString().slice(0, 10));
  };

  const rangeLabel = data
    ? `${new Date(`${data.weekStart}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${new Date(`${data.weekEnd}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`
    : "";

  const maxModelCost = data ? Math.max(1e-9, ...data.byModel.map((m) => m.costUsd)) : 1;
  const totalInput = data?.byModel.reduce((s, m) => s + m.tokens.input, 0) ?? 0;
  const totalOutput = data?.byModel.reduce((s, m) => s + m.tokens.output, 0) ?? 0;

  return (
    // Fills <main> (the same content area Settings/ProjectOverview/etc. render into, padding
    // and all), NOT a position:fixed full-viewport overlay — that earlier version sat on top of
    // the sidebar and top bar too, leaving no way to navigate anywhere else while this was open.
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: `${SPACE.lg}px ${SPACE.xl}px`, borderBottom: "1px solid var(--color-border)", flexShrink: 0 }}>
        <h1 style={{ margin: 0 }}>Weekly Rewind</h1>
        <div style={{ display: "flex", alignItems: "center", gap: SPACE.sm }}>
          <button onClick={() => shiftWeek(-7)} className="metaharn-icon-btn" aria-label="Previous week" style={iconBtnStyle(30)}>
            ‹
          </button>
          <span style={{ fontSize: TEXT.md, fontWeight: 600, minWidth: 190, textAlign: "center" }}>{rangeLabel}</span>
          <button onClick={() => shiftWeek(7)} className="metaharn-icon-btn" aria-label="Next week" style={iconBtnStyle(30)}>
            ›
          </button>
          <div style={{ width: 1, height: 20, background: "var(--color-border)", margin: "0 4px" }} />
          <button onClick={onClose} className="metaharn-icon-btn" aria-label="Close" style={iconBtnStyle(30)}>
            <CloseIcon size={16} />
          </button>
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: SPACE.xl }}>
        {error ? (
          <p style={{ color: "var(--color-error)" }}>Couldn't load Weekly Rewind: {error}</p>
        ) : !data ? (
          <p style={{ color: "var(--color-text-muted)" }}>Loading…</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: SPACE.lg, maxWidth: 1200 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: SPACE.md }}>
              <StatTile icon={<ClockIcon size={14} />} label="Agent time" value={formatMinutes(data.agentTimeMinutes)} subtitle="active agent time" />
              <StatTile icon={<ActivityIcon size={14} />} label="Sessions" value={data.sessionCount} />
              <StatTile icon={<DollarIcon size={14} />} label="Cost" value={formatUsd(data.costUsd)} subtitle="this week" />
              <StatTile icon={<ZapIcon size={14} />} label="Peak window" value={data.peakWindowLabel ?? "—"} subtitle={data.peakWindowLabel ? sessionCount(data.peakWindowSessionCount) : undefined} />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: SPACE.md, maxWidth: 620 }}>
              <StatTile icon={<FolderIcon size={14} />} label="Top project" value={data.topProjectName ?? "—"} subtitle={data.topProjectName ? sessionCount(data.topProjectSessionCount) : undefined} />
              <StatTile icon={<CalendarIcon size={14} />} label="Busiest day" value={data.busiestDayLabel ?? "—"} subtitle={data.busiestDayLabel ? sessionCount(data.busiestDaySessionCount) : undefined} />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: SPACE.md }}>
              <Card title="Sessions by Day">
                <BarChart
                  points={data.sessionsByDay.map((p) => ({ label: new Date(`${p.date}T00:00:00`).toLocaleDateString(undefined, { weekday: "short" }), value: p.sessionCount }))}
                  formatValue={(v) => String(Math.round(v))}
                />
              </Card>
              <Card title="Cost by Day">
                <BarChart
                  points={data.costByDay.map((p) => ({ label: new Date(`${p.date}T00:00:00`).toLocaleDateString(undefined, { weekday: "short" }), value: p.costUsd }))}
                  formatValue={(v) => `$${v.toFixed(0)}`}
                />
              </Card>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: SPACE.md }}>
              <Card title="Cost Breakdown">
                {data.byModel.length === 0 ? (
                  <Empty>No usage this week.</Empty>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: SPACE.md }}>
                    {data.byModel.map((m) => (
                      <div key={m.model}>
                        <div style={{ display: "flex", justifyContent: "space-between", gap: SPACE.sm, fontSize: TEXT.sm }}>
                          <span style={{ fontFamily: MONO, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.model}</span>
                          <span style={{ flexShrink: 0, color: "var(--color-text-muted)" }}>
                            {formatUsd(m.costUsd)} {formatTokens(m.tokens.input)}↑ {formatTokens(m.tokens.output)}↓
                          </span>
                        </div>
                        <div style={{ marginTop: 4, height: 6, borderRadius: 3, background: "var(--color-bg-hover)", overflow: "hidden" }}>
                          <div style={{ width: `${(m.costUsd / maxModelCost) * 100}%`, height: "100%", background: "var(--color-accent)" }} />
                        </div>
                        <div style={{ marginTop: 3, fontSize: 11, color: "var(--color-text-muted)" }}>{m.turns} turns</div>
                      </div>
                    ))}
                    <div style={{ borderTop: "1px solid var(--color-border)", paddingTop: SPACE.sm, fontSize: TEXT.sm, color: "var(--color-text-secondary)" }}>
                      Total: {formatUsd(data.costUsd)} · {formatTokens(totalInput)} input · {formatTokens(totalOutput)} output
                    </div>
                  </div>
                )}
              </Card>
              <Card title="Merged PRs">
                <Empty>Not tracked yet.</Empty>
              </Card>
              <Card title="Activity Heatmap">
                <ActivityHeatmap grid={data.heatmap} dayLabels={DOW_SHORT} />
              </Card>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
