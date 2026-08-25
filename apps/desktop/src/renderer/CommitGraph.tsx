import { useMemo } from "react";
import type { GitLogEntry } from "../preload/preload.js";
import { assignGraphLanes } from "./graphLayout.js";

/** Shared row geometry — GitPanel.tsx's Log tab and BranchExplorer.tsx both
 * give their commit rows this exact height/gap so the graph gutter's SVG
 * math lines up with the real DOM rows pixel-for-pixel. Row content is
 * clipped to this height rather than left auto-sized (see CommitRow in
 * GitPanel.tsx) — the graph has no way to know a variable row height ahead
 * of render, so the row height has to be the fixed, known quantity instead. */
export const LOG_ROW_HEIGHT = 34;
export const LOG_ROW_GAP = 8;

const LANE_SPACING = 16;
const DOT_RADIUS = 4;
const RING_RADIUS = 7;
const GUTTER_PADDING = 10;

/**
 * The graph gutter for a list of commit rows, in the exact order they're
 * rendered. Pure presentation over `assignGraphLanes` (graphLayout.ts) —
 * lane math lives there so GitPanel.tsx and BranchExplorer.tsx can never
 * end up computing two different (and possibly disagreeing) topologies.
 *
 * Vertical lines are drawn per lane by connecting each lane's consecutive
 * occurrences (not by walking parent pointers directly) — a lane, once
 * reserved for a target hash by `assignGraphLanes`, is only ever reoccupied
 * by that exact hash, so "next row where this lane's node appears" already
 * IS "where this lane's line continues to," whether that's a plain
 * first-parent continuation or a lane newly opened by a merge's second
 * parent. A lane whose reserved commit never appears in the loaded page
 * (fell past what's been paged in) gets an "open" tail drawn to the bottom
 * edge instead of stopping dead, so it reads as "more history below" rather
 * than a truncated/broken line.
 */
export function CommitGraph({ commits }: { commits: GitLogEntry[] }) {
  const { nodes, connections, laneCount } = useMemo(
    () => assignGraphLanes(commits.map((c) => ({ hash: c.hash, parents: c.parents }))),
    [commits],
  );

  const rowIndexByHash = useMemo(() => {
    const map = new Map<string, number>();
    commits.forEach((c, i) => map.set(c.hash, i));
    return map;
  }, [commits]);

  const laneOccurrences = new Map<number, number[]>();
  for (const [hash, node] of nodes) {
    const row = rowIndexByHash.get(hash);
    if (row == null) continue;
    const list = laneOccurrences.get(node.lane) ?? [];
    list.push(row);
    laneOccurrences.set(node.lane, list);
  }

  const step = LOG_ROW_HEIGHT + LOG_ROW_GAP;
  const rowY = (row: number) => row * step + LOG_ROW_HEIGHT / 2;
  const laneX = (lane: number) => lane * LANE_SPACING + GUTTER_PADDING;
  const height = commits.length * step - LOG_ROW_GAP;
  const width = laneCount * LANE_SPACING + GUTTER_PADDING * 2;

  const verticalSegments: { lane: number; y1: number; y2: number }[] = [];
  for (const [lane, rowsForLane] of laneOccurrences) {
    const rows = [...rowsForLane].sort((a, b) => a - b);
    for (let i = 0; i < rows.length - 1; i++) {
      verticalSegments.push({ lane, y1: rowY(rows[i]), y2: rowY(rows[i + 1]) });
    }
    const lastRow = rows[rows.length - 1];
    const lastCommit = commits[lastRow];
    if (lastCommit && lastCommit.parents.length > 0) {
      verticalSegments.push({ lane, y1: rowY(lastRow), y2: height });
    }
  }

  return (
    <svg width={width} height={height} style={{ flexShrink: 0, marginRight: 4 }}>
      {verticalSegments.map((seg, i) => (
        <line
          key={`v${i}`}
          x1={laneX(seg.lane)}
          y1={seg.y1}
          x2={laneX(seg.lane)}
          y2={seg.y2}
          stroke="var(--color-border)"
          strokeWidth={1.5}
        />
      ))}
      {connections.map((conn, i) => {
        const row = rowIndexByHash.get(conn.fromHash);
        if (row == null) return null;
        const [topRow, bottomRow] = conn.kind === "diverge" ? [row, row + 1] : [row - 1, row];
        const x1 = laneX(conn.fromLane);
        const y1 = rowY(topRow);
        const x2 = laneX(conn.toLane);
        const y2 = rowY(bottomRow);
        const midY = (y1 + y2) / 2;
        return (
          <path
            key={`c${i}`}
            d={`M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`}
            fill="none"
            stroke="var(--color-border)"
            strokeWidth={1.5}
          />
        );
      })}
      {commits.map((c, row) => {
        const node = nodes.get(c.hash);
        if (!node) return null;
        const isHead = c.refs.includes("HEAD");
        const cx = laneX(node.lane);
        const cy = rowY(row);
        return (
          <g key={c.hash}>
            {isHead && <circle cx={cx} cy={cy} r={RING_RADIUS} fill="none" stroke="var(--color-accent)" strokeWidth={1.5} />}
            <circle cx={cx} cy={cy} r={DOT_RADIUS} fill={isHead ? "var(--color-accent)" : "var(--color-text-muted)"} />
          </g>
        );
      })}
    </svg>
  );
}
