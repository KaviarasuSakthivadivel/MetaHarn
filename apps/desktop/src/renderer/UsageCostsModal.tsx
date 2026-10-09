import { useEffect, useState, type ReactNode } from "react";
import type { UsageSummary } from "../preload/preload.js";
import { RADIUS, SPACE, SegmentedControl, TEXT } from "./ui.js";
import { CloseIcon, DollarIcon } from "./icons.js";
import { BarChart, StatTile } from "./UsageCharts.js";

const MONO = '"IBM Plex Mono", Menlo, Monaco, monospace';

function formatUsd(v: number): string {
  return `$${v.toFixed(2)}`;
}
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
function dayLabel(dateIso: string): string {
  const todayIso = new Date().toISOString().slice(0, 10);
  if (dateIso === todayIso) return "Today";
  return new Date(`${dateIso}T00:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function iconBtnStyle(size: number): React.CSSProperties {
  return { display: "flex", alignItems: "center", justifyContent: "center", width: size, height: size, border: "none", borderRadius: RADIUS.md, background: "transparent", color: "var(--color-text-secondary)", cursor: "pointer" };
}

export default function UsageCostsModal({ onClose }: { onClose: () => void }) {
  // SegmentedControl is generic over string values only — rangeDays stays a string here and
  // converts to a number only where the IPC call/math actually needs one.
  const [rangeDaysStr, setRangeDaysStr] = useState<"7" | "30" | "90">("7");
  const rangeDays = Number(rangeDaysStr) as 7 | 30 | 90;
  const [metric, setMetric] = useState<"cost" | "tokens">("cost");
  const [data, setData] = useState<UsageSummary | null>(null);
  // A rejected IPC call with no .catch() here previously just left `data` null forever — the
  // "Loading…" state below never had a failure branch to fall into, so a real error (e.g. the
  // handler not being registered yet after a dev-server restart) looked identical to "still
  // fetching" with nothing in the UI to tell them apart.
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    setError(null);
    window.metaharn
      .getUsageSummary(rangeDays)
      .then(setData)
      .catch((err: Error) => setError(err.message));
  };
  useEffect(refresh, [rangeDays]);

  const maxModelCost = data ? Math.max(1e-9, ...data.byModel.map((m) => m.costUsd)) : 1;

  return (
    // Fills <main> (the same content area Settings/ProjectOverview/etc. render into, padding
    // and all), NOT a position:fixed full-viewport overlay — that earlier version sat on top of
    // the sidebar and top bar too, leaving no way to navigate anywhere else while this was open.
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: `${SPACE.lg}px ${SPACE.xl}px`, borderBottom: "1px solid var(--color-border)", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ color: "var(--color-status-working)", display: "flex" }}>
            <DollarIcon size={20} />
          </span>
          <h1 style={{ margin: 0 }}>Usage & Estimated Costs</h1>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: SPACE.sm }}>
          <button onClick={refresh} className="metaharn-icon-btn" aria-label="Refresh" style={iconBtnStyle(30)}>
            ↻
          </button>
          <button onClick={onClose} className="metaharn-icon-btn" aria-label="Close" style={iconBtnStyle(30)}>
            <CloseIcon size={16} />
          </button>
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: SPACE.xl }}>
        <div style={{ display: "flex", flexDirection: "column", gap: SPACE.lg, maxWidth: 1200 }}>
          <p style={{ margin: 0, fontSize: TEXT.sm, color: "var(--color-text-muted)" }}>
            Cost values are estimates based on published Claude model list prices — not a live billing figure. Usage data stays in your local database.
          </p>

          {error ? (
            <p style={{ color: "var(--color-error)" }}>Couldn't load usage data: {error}</p>
          ) : !data ? (
            <p style={{ color: "var(--color-text-muted)" }}>Loading…</p>
          ) : (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: SPACE.md }}>
                <StatTile icon={<DollarIcon size={14} />} label="Today" value={formatUsd(data.todayCostUsd)} />
                <StatTile icon={<DollarIcon size={14} />} label={`Last ${rangeDays} days`} value={formatUsd(data.rangeCostUsd)} />
                <StatTile icon={<DollarIcon size={14} />} label={`Last ${rangeDays} days`} value={formatTokens(data.rangeTokens)} subtitle="tokens" />
              </div>

              <Card>
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: SPACE.sm, marginBottom: SPACE.lg }}>
                  <div>
                    <Eyebrow>Daily cost</Eyebrow>
                    <div style={{ fontSize: TEXT.base, color: "var(--color-text-secondary)", marginTop: 2 }}>
                      {formatUsd(data.rangeCostUsd)} over {rangeDays} days
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: SPACE.sm }}>
                    <SegmentedControl
                      value={metric}
                      onChange={setMetric}
                      options={[
                        { value: "cost", label: "Cost" },
                        { value: "tokens", label: "Tokens" },
                      ]}
                    />
                    <SegmentedControl
                      value={rangeDaysStr}
                      onChange={setRangeDaysStr}
                      options={[
                        { value: "7", label: "7d" },
                        { value: "30", label: "30d" },
                        { value: "90", label: "90d" },
                      ]}
                    />
                  </div>
                </div>
                <BarChart
                  points={data.dailyCost.map((p) => ({ label: rangeDays > 30 ? "" : p.label, value: metric === "cost" ? p.costUsd : p.tokens }))}
                  formatValue={(v) => (metric === "cost" ? `$${v.toFixed(0)}` : formatTokens(v))}
                  height={220}
                />
              </Card>

              <Card>
                <Eyebrow>Cost by model</Eyebrow>
                <div style={{ marginTop: SPACE.md }}>
                  {data.byModel.length === 0 ? (
                    <p style={{ fontSize: TEXT.sm, color: "var(--color-text-muted)", margin: 0 }}>No usage in this range.</p>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: SPACE.md }}>
                      {data.byModel.map((m) => (
                        <div key={m.model}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: SPACE.sm }}>
                            <span style={{ fontSize: TEXT.md, fontWeight: 600, fontFamily: MONO }}>{m.model}</span>
                            <span style={{ fontSize: TEXT.base, fontWeight: 600, flexShrink: 0 }}>{formatUsd(m.costUsd)}</span>
                          </div>
                          <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginTop: 2 }}>
                            {formatTokens(m.tokens.input)} in / {formatTokens(m.tokens.output)} out / {formatTokens(m.tokens.cacheWrite)} cache-w / {formatTokens(m.tokens.cacheRead)} cache-r
                          </div>
                          <div style={{ marginTop: 6, height: 6, borderRadius: 3, background: "var(--color-bg-hover)", overflow: "hidden" }}>
                            <div style={{ width: `${(m.costUsd / maxModelCost) * 100}%`, height: "100%", background: "var(--color-accent)" }} />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </Card>

              <Card>
                <Eyebrow>Daily usage & cost</Eyebrow>
                <div style={{ marginTop: SPACE.md, display: "flex", flexDirection: "column" }}>
                  {[...data.dailyCost].reverse().map((p) => (
                    <div key={p.date} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: `${SPACE.sm}px 0`, borderBottom: "1px solid var(--color-border)", gap: SPACE.sm }}>
                      <span style={{ fontSize: TEXT.base, fontWeight: p.date === new Date().toISOString().slice(0, 10) ? 600 : 400 }}>{dayLabel(p.date)}</span>
                      <span style={{ display: "flex", alignItems: "center", gap: SPACE.lg, fontSize: TEXT.sm, color: "var(--color-text-muted)" }}>
                        <span>{formatTokens(p.tokens)} tokens</span>
                        <span style={{ fontWeight: 600, color: "var(--color-text)", minWidth: 60, textAlign: "right" }}>{formatUsd(p.costUsd)}</span>
                      </span>
                    </div>
                  ))}
                </div>
              </Card>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Card({ children }: { children: ReactNode }) {
  return (
    <div style={{ border: "1px solid var(--color-border)", borderRadius: RADIUS.lg, background: "var(--color-bg-elevated)", boxShadow: "var(--shadow-sm)", padding: SPACE.lg }}>{children}</div>
  );
}

function Eyebrow({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: TEXT.xs, fontWeight: 700, letterSpacing: 0.5, color: "var(--color-text-muted)" }}>{String(children).toUpperCase()}</div>;
}
