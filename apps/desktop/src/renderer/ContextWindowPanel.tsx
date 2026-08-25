import type { SessionStats } from "../preload/preload.js";
import { DatabaseIcon } from "./icons.js";
import { ValueRow } from "./ui.js";

interface ContextWindowPanelProps {
  stats: SessionStats | null;
  modelId?: string;
  onClose: () => void;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

function Bar({ percent, color = "var(--color-accent)" }: { percent: number; color?: string }) {
  return (
    <div style={{ height: 6, borderRadius: 3, background: "var(--color-bg-hover)", overflow: "hidden" }}>
      <div
        style={{
          height: "100%",
          width: `${Math.min(100, Math.max(0, percent))}%`,
          background: color,
          borderRadius: 3,
        }}
      />
    </div>
  );
}

/**
 * `stats.contextUsage` is the *latest turn's* context payload — how full the
 * window is right now. `stats.tokens.{input,output}` is cumulative over the
 * whole session (aggregated over all entries, including compacted-away
 * history — see ipc.ts's metaharn:getSessionStats). Two different questions,
 * so this panel shows both side by side rather than picking one.
 */
export default function ContextWindowPanel({ stats, modelId, onClose }: ContextWindowPanelProps) {
  const usage = stats?.contextUsage;
  const percent = usage?.percent ?? null;
  const used = usage?.tokens ?? null;
  const total = usage?.contextWindow ?? null;
  const remaining = used !== null && total !== null ? total - used : null;
  const remainingPercent = percent !== null ? 100 - percent : null;

  return (
    <div
      style={{
        position: "absolute",
        top: 44,
        right: 0,
        width: 360,
        maxHeight: 520,
        overflowY: "auto",
        background: "var(--color-bg-secondary)",
        border: "1px solid var(--color-border)",
        borderRadius: 10,
        boxShadow: "0 8px 24px rgba(0,0,0,0.3)",
        zIndex: 20,
        padding: 16,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--color-accent)" }}>
          <DatabaseIcon size={16} />
          <strong style={{ fontSize: 14, color: "var(--color-text)" }}>Context Window</strong>
        </div>
        <button
          onClick={onClose}
          aria-label="Close context window panel"
          className="metaharn-tooltip"
          style={{ border: "none", background: "transparent", color: "var(--color-text-secondary)", cursor: "pointer", fontSize: 16, lineHeight: 1 }}
        >
          ×
        </button>
      </div>

      {!stats ? (
        <p style={{ fontSize: 13, color: "var(--color-text-muted)" }}>No stats yet — send a message first.</p>
      ) : (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
            <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>Usage</span>
            <span style={{ fontSize: 18, fontWeight: 700, color: "var(--color-accent)", fontFamily: '"IBM Plex Mono", Menlo, Monaco, monospace' }}>
              {percent !== null ? `${percent.toFixed(1)}%` : "—"}
            </span>
          </div>
          <Bar percent={percent ?? 0} />
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, marginBottom: 18, fontSize: 11.5, color: "var(--color-text-muted)", fontFamily: '"IBM Plex Mono", Menlo, Monaco, monospace' }}>
            <span>{used !== null ? `${formatTokens(used)} used` : "unknown"}</span>
            <span>{total !== null ? `${formatTokens(total)} total` : ""}</span>
          </div>

          <div style={{ display: "flex", gap: 10, marginBottom: 20 }}>
            <div style={{ flex: 1, border: "1px solid var(--color-border)", borderRadius: 8, padding: 10 }}>
              <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginBottom: 4 }}>↓ Input Tokens</div>
              <div style={{ fontSize: 16, fontWeight: 700, fontFamily: '"IBM Plex Mono", Menlo, Monaco, monospace' }}>
                {formatTokens(stats.tokens.input)}
              </div>
            </div>
            <div style={{ flex: 1, border: "1px solid var(--color-border)", borderRadius: 8, padding: 10 }}>
              <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginBottom: 4 }}>↑ Output Tokens</div>
              <div style={{ fontSize: 16, fontWeight: 700, fontFamily: '"IBM Plex Mono", Menlo, Monaco, monospace' }}>
                {formatTokens(stats.tokens.output)}
              </div>
            </div>
          </div>

          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.5, color: "var(--color-text-muted)", marginBottom: 10 }}>
            BREAKDOWN
          </div>
          {(
            [
              ["Context (latest turn)", used, "var(--color-accent)"],
              ["Cumulative input", stats.tokens.input, "var(--color-text-secondary)"],
              ["Cumulative output", stats.tokens.output, "var(--color-accent)"],
            ] as const
          ).map(([label, value, color]) => (
            <div key={label} style={{ marginBottom: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 4 }}>
                <span style={{ color: "var(--color-text-secondary)" }}>{label}</span>
                <span style={{ fontFamily: '"IBM Plex Mono", Menlo, Monaco, monospace' }}>{value !== null ? formatTokens(value) : "—"}</span>
              </div>
              <Bar percent={total && value !== null ? (value / total) * 100 : 0} color={color} />
            </div>
          ))}

          <div style={{ marginTop: 14, border: "1px solid var(--color-border)", borderRadius: 8, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
            <ValueRow label="Model" value={modelId ?? "—"} mono />
            <ValueRow label="Window Size" value={total !== null ? `${formatTokens(total)} tokens` : "—"} mono />
            <ValueRow
              label="Remaining"
              value={remaining !== null ? `${formatTokens(remaining)} (${remainingPercent!.toFixed(1)}%)` : "—"}
              mono
            />
          </div>
        </>
      )}
    </div>
  );
}
