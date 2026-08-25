import { useEffect, useRef, useState } from "react";
import type { GitBranchInfo, GitLogEntry } from "../preload/preload.js";
import { CommitRow } from "./GitPanel.js";
import { CommitGraph, LOG_ROW_GAP } from "./CommitGraph.js";
import { RADIUS, SPACE, TEXT } from "./ui.js";

interface BranchExplorerProps {
  cwd: string;
  /** Opens the explorer pre-scoped to one branch instead of "All branches"
   * — e.g. the Branches tab's per-row "View commits" action. */
  initialBranch?: string;
}

const LOG_PAGE_SIZE = 50;
const ALL_BRANCHES = "";

/**
 * Standalone content for the branch-explorer `BrowserWindow` (see main.ts's
 * createBranchExplorerWindow / main.tsx's `?window=branchExplorer` routing)
 * — originally a same-window MainView, changed to a real second window on
 * request so it reads as the primary "full size" browsing surface rather
 * than a same-window navigation. No `onBack`: closing the window IS "back,"
 * same convention CommitDiffWindow.tsx already uses. Not wrapped in the
 * main app's SettingsProvider (separate window, separate document) — same
 * reasoning CommitDiffWindow.tsx documents for itself. Same paginated
 * getGitLog/getGitBranches calls GitPanel.tsx's Log tab already uses (both
 * server-side capped, see git.ts) — this is just a bigger surface for the
 * same data, plus a branch-scope selector.
 */
export default function BranchExplorer({ cwd, initialBranch }: BranchExplorerProps) {
  const [branches, setBranches] = useState<GitBranchInfo[] | null | undefined>(undefined);
  const [scope, setScope] = useState<string>(initialBranch ?? ALL_BRANCHES);
  const [log, setLog] = useState<GitLogEntry[]>([]);
  const [skip, setSkip] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  // Ref, not state — needs to gate a second call SYNCHRONOUSLY (state
  // updates land a tick later, which isn't fast enough to stop dev-mode
  // StrictMode's double-invoke-on-mount, or a rapid double-click, from
  // firing the same fetch twice and duplicating every commit in the
  // appended list — this exact bug shipped once already, see GitPanel.tsx).
  const fetchInFlight = useRef(false);
  // Bumped on every scope/cwd change so an in-flight response that arrives
  // AFTER a newer request started can recognize it's stale and no-op,
  // instead of clobbering the newer scope's results.
  const requestId = useRef(0);

  useEffect(() => {
    void window.metaharnFiles.getGitBranches(cwd).then(setBranches);
  }, [cwd]);

  // Re-fetch from scratch whenever the branch scope changes — a fresh
  // pagination cursor, not an append.
  useEffect(() => {
    const id = ++requestId.current;
    setLog([]);
    setSkip(0);
    setHasMore(true);
    setLoading(true);
    fetchInFlight.current = true;
    void window.metaharnFiles.getGitLog(cwd, 0, LOG_PAGE_SIZE, scope || undefined).then((page) => {
      if (requestId.current !== id) return; // superseded by a newer scope/cwd change
      fetchInFlight.current = false;
      setLoading(false);
      if (!page) {
        setHasMore(false);
        return;
      }
      setLog(page);
      setSkip(page.length);
      if (page.length < LOG_PAGE_SIZE) setHasMore(false);
    });
  }, [cwd, scope]);

  const loadMore = () => {
    if (fetchInFlight.current) return;
    fetchInFlight.current = true;
    const id = requestId.current;
    setLoading(true);
    void window.metaharnFiles.getGitLog(cwd, skip, LOG_PAGE_SIZE, scope || undefined).then((page) => {
      if (requestId.current !== id) return;
      fetchInFlight.current = false;
      setLoading(false);
      if (!page) {
        setHasMore(false);
        return;
      }
      setLog((prev) => [...prev, ...page]);
      setSkip((s) => s + page.length);
      if (page.length < LOG_PAGE_SIZE) setHasMore(false);
    });
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        background: "var(--color-bg)",
        color: "var(--color-text)",
        fontFamily: "'IBM Plex Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: SPACE.md,
          flexWrap: "wrap",
          flexShrink: 0,
          borderBottom: "1px solid var(--color-border)",
          // Left clearance for macOS's inset traffic-light buttons (this
          // window shares the main window's trafficLightPosition: {x:16,
          // y:16} — see main.ts / CommitDiffWindow.tsx's identical fix) —
          // same known clearance TopBar.tsx documents and uses. No
          // interactive element sits in that dead zone, so the whole bar
          // doubles as the window's drag handle; the select/buttons inside
          // opt back out individually.
          padding: `${SPACE.md}px ${SPACE.lg}px ${SPACE.md}px 90px`,
          ...({ WebkitAppRegion: "drag" } as React.CSSProperties),
        }}
      >
        <h2 style={{ margin: 0, fontSize: TEXT.xl }}>Branch Explorer</h2>
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          style={{
            border: "1px solid var(--color-border)",
            borderRadius: RADIUS.sm,
            background: "var(--color-bg-elevated)",
            color: "var(--color-text)",
            padding: "5px 8px",
            fontSize: TEXT.sm,
            ...({ WebkitAppRegion: "no-drag" } as React.CSSProperties),
          }}
        >
          <option value={ALL_BRANCHES}>All branches</option>
          {branches?.map((b) => (
            <option key={b.name} value={b.name}>
              {b.name}
            </option>
          ))}
        </select>
        <span style={{ fontSize: TEXT.sm, color: "var(--color-text-muted)" }}>
          {log.length}
          {hasMore ? "+" : ""} commits
        </span>
      </div>

      {/* Everything below the header needs its own page padding now — this
          used to sit inside App.tsx's <main style={{padding:24}}>, but as a
          standalone window there's no such wrapper anymore. */}
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", padding: `${SPACE.lg}px`, overflow: "hidden" }}>
        {branches !== undefined && branches !== null && branches.length > 0 && (
          <div style={{ display: "flex", gap: SPACE.sm, overflowX: "auto", whiteSpace: "nowrap", paddingBottom: SPACE.sm, marginBottom: SPACE.md, flexShrink: 0 }}>
            {branches.map((b) => (
              <button
                key={b.name}
                onClick={() => setScope(b.name)}
                style={{
                  flexShrink: 0,
                  border: `1px solid ${scope === b.name ? "var(--color-accent)" : "var(--color-border)"}`,
                  borderRadius: RADIUS.xl,
                  background: scope === b.name ? "var(--color-accent-soft)" : "var(--color-bg-elevated)",
                  color: scope === b.name ? "var(--color-accent)" : "var(--color-text-secondary)",
                  cursor: "pointer",
                  padding: "4px 12px",
                  fontSize: TEXT.sm,
                  fontFamily: '"IBM Plex Mono", Menlo, Monaco, monospace',
                }}
              >
                {b.name}
                {b.isCurrent ? " (HEAD)" : ""}
              </button>
            ))}
          </div>
        )}

        <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          {log.length === 0 && !loading && (
            <p style={{ fontSize: TEXT.base, color: "var(--color-text-muted)" }}>No commits found.</p>
          )}
          {log.length > 0 && (
            <div style={{ display: "flex" }}>
              {/* Real topology (branch/merge lanes from actual parent-hash
                  data), not a decorative dot-per-row line — see graphLayout.ts.
                  Row height/gap here must match CommitRow's fixed height
                  exactly (see GitPanel.tsx) or the lines drift out of
                  alignment with their rows. */}
              <CommitGraph commits={log} />
              <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: LOG_ROW_GAP, paddingLeft: SPACE.sm }}>
                {log.map((entry) => (
                  <CommitRow key={entry.hash} entry={entry} onOpen={() => void window.metaharn.openCommitDiffWindow(cwd, entry.hash)} />
                ))}
              </div>
            </div>
          )}
          {hasMore && (
            <button
              onClick={loadMore}
              disabled={loading}
              style={{
                width: "100%",
                marginTop: SPACE.md,
                border: "1px dashed var(--color-border)",
                borderRadius: RADIUS.md,
                background: "transparent",
                color: "var(--color-text-secondary)",
                cursor: loading ? "default" : "pointer",
                padding: SPACE.sm,
                fontSize: TEXT.sm,
              }}
            >
              {loading ? "Loading..." : "Load more"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
