import { useState, type ReactNode } from "react";
import { RADIUS, SPACE, TEXT } from "./ui.js";

/** One bordered stat tile — Weekly Rewind's "Agent time"/"Sessions"/"Cost"/etc, Usage & Estimated
 * Costs' "Today"/"Last N days" tiles. Same Card shape this app already uses elsewhere
 * (SettingsPage.tsx, ProjectOverview.tsx), just with an icon+label header and a big value. */
export function StatTile({ icon, label, value, subtitle }: { icon: ReactNode; label: string; value: ReactNode; subtitle?: string }) {
  return (
    <div
      style={{
        border: "1px solid var(--color-border)",
        borderRadius: RADIUS.lg,
        background: "var(--color-bg-elevated)",
        boxShadow: "var(--shadow-sm)",
        padding: SPACE.lg,
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--color-text-muted)", fontSize: TEXT.sm }}>
        {icon}
        {label}
      </div>
      <div style={{ marginTop: 10, fontSize: 26, fontWeight: 800, letterSpacing: "-0.015em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value}</div>
      {subtitle && <div style={{ marginTop: 2, fontSize: TEXT.sm, color: "var(--color-text-muted)" }}>{subtitle}</div>}
    </div>
  );
}

/** Rounds a chart max up to a "nice" gridline-friendly number (1/2/5 × 10^n) — a plain
 * max/4 would print labels like "$11.78" instead of "$14". */
function niceCeil(value: number): number {
  if (value <= 0) return 1;
  const exp = Math.floor(Math.log10(value));
  const base = Math.pow(10, exp);
  for (const step of [1, 2, 5, 10]) {
    if (value <= step * base) return step * base;
  }
  return 10 * base;
}

/** A single-series bar chart — Sessions by Day, Cost by Day, Daily Cost. One accent hue (this
 * is magnitude-over-category, not an identity comparison, so no legend: the panel title above
 * each chart already names the one series — see the dataviz skill's color-formula.md). Rounded
 * 4px data-ends, a recessive gridline/baseline, and a per-bar hover tooltip rather than a label
 * on every bar. */
export function BarChart({
  points,
  formatValue,
  height = 180,
}: {
  points: { label: string; value: number }[];
  formatValue: (v: number) => string;
  height?: number;
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const max = niceCeil(Math.max(0, ...points.map((p) => p.value)));
  const yLabels = [0, 0.25, 0.5, 0.75, 1].map((f) => max * f);
  const Y_AXIS_WIDTH = 46;

  return (
    <div>
      <div style={{ display: "flex" }}>
        <div style={{ width: Y_AXIS_WIDTH, flexShrink: 0, display: "flex", flexDirection: "column-reverse", justifyContent: "space-between", height, fontSize: 11, color: "var(--color-text-muted)", textAlign: "right", paddingRight: 8 }}>
          {yLabels.map((v, i) => (
            <span key={i} style={{ transform: "translateY(50%)" }}>
              {formatValue(v)}
            </span>
          ))}
        </div>
        <div style={{ flex: 1, position: "relative", height }}>
          {yLabels.map((_, i) => (
            <div key={i} style={{ position: "absolute", left: 0, right: 0, bottom: `${(i / (yLabels.length - 1)) * 100}%`, borderTop: "1px solid var(--color-border)", opacity: i === 0 ? 1 : 0.5 }} />
          ))}
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "flex-end", gap: 4 }}>
            {points.map((p, i) => (
              <div
                key={i}
                onMouseEnter={() => setHoverIdx(i)}
                onMouseLeave={() => setHoverIdx(null)}
                style={{ flex: 1, minWidth: 0, display: "flex", justifyContent: "center", height: "100%", alignItems: "flex-end", position: "relative" }}
              >
                {hoverIdx === i && (
                  <div
                    style={{
                      position: "absolute",
                      bottom: `calc(${(p.value / max) * 100}% + 6px)`,
                      background: "var(--color-text)",
                      color: "var(--color-bg)",
                      fontSize: 11,
                      fontWeight: 600,
                      padding: "2px 7px",
                      borderRadius: RADIUS.sm,
                      whiteSpace: "nowrap",
                      zIndex: 2,
                      pointerEvents: "none",
                    }}
                  >
                    {formatValue(p.value)}
                  </div>
                )}
                <div
                  style={{
                    width: "60%",
                    maxWidth: 28,
                    height: p.value > 0 ? `${Math.max((p.value / max) * 100, 1.5)}%` : 0,
                    background: hoverIdx === i ? "var(--color-accent-hover)" : "var(--color-accent)",
                    borderRadius: "4px 4px 0 0",
                    transition: "background 0.12s ease",
                  }}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
      <div style={{ display: "flex", marginTop: 6 }}>
        <div style={{ width: Y_AXIS_WIDTH, flexShrink: 0 }} />
        <div style={{ flex: 1, display: "flex", gap: 4 }}>
          {points.map((p, i) => (
            <div key={i} style={{ flex: 1, minWidth: 0, textAlign: "center", fontSize: 11, color: "var(--color-text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {p.label}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Weekly Rewind's Activity Heatmap — a sequential single-hue ramp (the accent, at increasing
 * opacity) keyed to turn count per day×hour cell, exactly the "sequential = one hue, light→dark"
 * rule from the dataviz skill. */
export function ActivityHeatmap({ grid, dayLabels }: { grid: number[][]; dayLabels: string[] }) {
  const max = Math.max(1, ...grid.flat());
  const hourMarks = [0, 3, 6, 9, 12, 15, 18, 21];
  return (
    <div>
      <div style={{ display: "flex", gap: 2, marginLeft: 20, marginBottom: 4 }}>
        {Array.from({ length: 24 }).map((_, h) => (
          <div key={h} style={{ width: 14, flexShrink: 0, fontSize: 9, color: "var(--color-text-muted)", textAlign: "center" }}>
            {hourMarks.includes(h) ? h : ""}
          </div>
        ))}
      </div>
      {grid.map((row, d) => (
        <div key={d} style={{ display: "flex", alignItems: "center", gap: 2, marginBottom: 2 }}>
          <div style={{ width: 16, flexShrink: 0, fontSize: 10, color: "var(--color-text-muted)" }}>{dayLabels[d]}</div>
          {row.map((count, h) => (
            <div
              key={h}
              title={count > 0 ? `${dayLabels[d]} ${h}:00 — ${count} turn${count === 1 ? "" : "s"}` : undefined}
              style={{
                width: 14,
                height: 14,
                flexShrink: 0,
                borderRadius: 3,
                background: count === 0 ? "var(--color-bg-hover)" : "var(--color-accent)",
                opacity: count === 0 ? 1 : Math.min(1, 0.3 + (count / max) * 0.7),
              }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
