import { useEffect, useMemo, useState } from "react";
import type { CommitFileEntry, CommitFileList, CommitMeta, FileDiffContent } from "../preload/preload.js";
import { projectLabel } from "./format.js";
import { RADIUS, SPACE, TEXT } from "./ui.js";
import MonacoFileDiff from "./MonacoFileDiff.js";

interface CommitDiffWindowProps {
  cwd: string;
  hash: string;
}

type StatusFilter = "all" | "added" | "modified" | "deleted";

const STATUS_COLOR: Record<CommitFileEntry["status"], string> = {
  added: "var(--color-status-working)",
  modified: "var(--color-status-waiting)",
  deleted: "var(--color-error)",
  renamed: "var(--color-text-muted)",
};

const STATUS_LETTER: Record<CommitFileEntry["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
};

// Lines-changed threshold past which a file's diff isn't fetched/rendered
// until the user explicitly asks for it — real behavior, not cosmetic: a
// big mono repo commit can touch files with tens of thousands of changed
// lines, and creating a Monaco diff editor for each of those eagerly would
// make this window unusable. Matches the reference product's own copy.
const LARGE_DIFF_THRESHOLD = 800;

/**
 * Standalone content for the commit-diff `BrowserWindow` (see main.ts's
 * createCommitDiffWindow / main.tsx's `?window=commitDiff` routing).
 * main.tsx wraps this window in the same SettingsProvider the main window
 * uses, so it picks up the user's real theme choice — both theme.css's CSS
 * variables (applied to this window's own `document` the same way as the
 * main one) and Monaco's vs/vs-dark pick (see MonacoFileDiff.tsx, via
 * useResolvedTheme()) follow it, not just the OS light/dark preference.
 */
export default function CommitDiffWindow({ cwd, hash }: CommitDiffWindowProps) {
  const [meta, setMeta] = useState<CommitMeta | null | undefined>(undefined);
  const [fileList, setFileList] = useState<CommitFileList | null | undefined>(undefined);
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [forceExpandedPaths, setForceExpandedPaths] = useState<Set<string>>(new Set());
  const [viewedPaths, setViewedPaths] = useState<Set<string>>(new Set());

  useEffect(() => {
    void window.metaharnFiles.getCommitMeta(cwd, hash).then(setMeta);
    void window.metaharnFiles.getCommitFileList(cwd, hash).then(setFileList);
  }, [cwd, hash]);

  const files = fileList?.files ?? [];

  const counts = useMemo(
    () => ({
      all: files.length,
      added: files.filter((f) => f.status === "added").length,
      modified: files.filter((f) => f.status === "modified").length,
      deleted: files.filter((f) => f.status === "deleted").length,
    }),
    [files],
  );

  const visibleFiles = filter === "all" ? files : files.filter((f) => f.status === filter);

  const totals = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const f of files) {
      additions += f.additions ?? 0;
      deletions += f.deletions ?? 0;
    }
    return { additions, deletions };
  }, [files]);

  const toggleExpanded = (path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const toggleViewed = (path: string) => {
    setViewedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  if (meta === undefined || fileList === undefined) {
    return (
      <div style={{ padding: SPACE.xl, color: "var(--color-text-muted)", background: "var(--color-bg)", height: "100vh" }}>
        Loading commit…
      </div>
    );
  }
  if (meta === null || fileList === null) {
    return (
      <div style={{ padding: SPACE.xl, color: "var(--color-error)", background: "var(--color-bg)", height: "100vh" }}>
        Couldn't load this commit — not a git repository, or the commit no longer exists.
      </div>
    );
  }

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
          // Left clearance for macOS's inset traffic-light buttons (this
          // window shares the main window's trafficLightPosition: {x:16,
          // y:16} — see main.ts) — same known clearance TopBar.tsx documents
          // and uses (16px start + ~54px button group + 20px breathing
          // room), not a re-guess. The header has no interactive elements,
          // so the whole bar can double as the window's drag handle (no
          // native title strip left to grab otherwise, same as TopBar.tsx).
          padding: `${SPACE.md}px ${SPACE.lg}px ${SPACE.md}px 90px`,
          borderBottom: "1px solid var(--color-border)",
          flexShrink: 0,
          ...({ WebkitAppRegion: "drag" } as React.CSSProperties),
        }}
      >
        <div style={{ fontSize: TEXT.sm, color: "var(--color-text-muted)" }}>{projectLabel(cwd)}</div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 2 }}>
          <span style={{ fontFamily: '"IBM Plex Mono", Menlo, Monaco, monospace', fontSize: TEXT.sm, color: "var(--color-text-muted)", flexShrink: 0 }}>
            {meta.hash.slice(0, 7)}
          </span>
          <span
            style={{
              fontSize: TEXT.lg,
              fontWeight: 600,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {meta.message}
          </span>
        </div>
      </div>

      {fileList.truncated && (
        <div
          style={{
            padding: `${SPACE.sm}px ${SPACE.lg}px`,
            background: "var(--color-accent-soft)",
            color: "var(--color-accent)",
            fontSize: TEXT.sm,
            flexShrink: 0,
          }}
        >
          Too many files. Showing first {fileList.files.length} of {fileList.totalCount} files.
        </div>
      )}

      <div
        style={{
          display: "flex",
          gap: SPACE.lg,
          padding: `${SPACE.sm}px ${SPACE.lg}px`,
          borderBottom: "1px solid var(--color-border)",
          flexShrink: 0,
        }}
      >
        {(["all", "added", "modified", "deleted"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            style={{
              border: "none",
              background: "transparent",
              padding: "4px 2px",
              fontSize: TEXT.sm,
              fontWeight: filter === f ? 700 : 400,
              color: filter === f ? "var(--color-text)" : "var(--color-text-muted)",
              borderBottom: filter === f ? "2px solid var(--color-accent)" : "2px solid transparent",
              cursor: "pointer",
              textTransform: "capitalize",
            }}
          >
            {f} {counts[f]}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: SPACE.lg }}>
        {visibleFiles.length === 0 && (
          <p style={{ color: "var(--color-text-muted)", fontSize: TEXT.sm }}>No files match this filter.</p>
        )}
        {visibleFiles.map((f) => (
          <FileRow
            key={f.path}
            cwd={cwd}
            hash={hash}
            file={f}
            isExpanded={expandedPaths.has(f.path)}
            isForceExpanded={forceExpandedPaths.has(f.path)}
            onToggle={() => toggleExpanded(f.path)}
            onForceExpand={() => setForceExpandedPaths((prev) => new Set(prev).add(f.path))}
            isViewed={viewedPaths.has(f.path)}
            onToggleViewed={() => toggleViewed(f.path)}
          />
        ))}
      </div>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          padding: `${SPACE.sm}px ${SPACE.lg}px`,
          borderTop: "1px solid var(--color-border)",
          fontSize: TEXT.sm,
          color: "var(--color-text-secondary)",
          fontFamily: '"IBM Plex Mono", Menlo, Monaco, monospace',
          flexShrink: 0,
        }}
      >
        <span>{files.length} files</span>
        <span>
          <span style={{ color: "var(--color-status-working)" }}>+{totals.additions}</span>{" "}
          <span style={{ color: "var(--color-error)" }}>-{totals.deletions}</span>
        </span>
      </div>
    </div>
  );
}

function FileRow({
  cwd,
  hash,
  file,
  isExpanded,
  isForceExpanded,
  onToggle,
  onForceExpand,
  isViewed,
  onToggleViewed,
}: {
  cwd: string;
  hash: string;
  file: CommitFileEntry;
  isExpanded: boolean;
  isForceExpanded: boolean;
  onToggle: () => void;
  onForceExpand: () => void;
  isViewed: boolean;
  onToggleViewed: () => void;
}) {
  const linesChanged = (file.additions ?? 0) + (file.deletions ?? 0);
  const isLarge = linesChanged > LARGE_DIFF_THRESHOLD;
  const shouldRenderDiff = isExpanded && !file.binary && (!isLarge || isForceExpanded);
  const lastSlash = file.path.lastIndexOf("/");
  const name = lastSlash === -1 ? file.path : file.path.slice(lastSlash + 1);
  const dir = lastSlash === -1 ? "" : file.path.slice(0, lastSlash + 1);

  return (
    <div style={{ border: "1px solid var(--color-border)", borderRadius: RADIUS.md, marginBottom: SPACE.sm, overflow: "hidden" }}>
      <div
        onClick={() => !file.binary && onToggle()}
        style={{
          display: "flex",
          alignItems: "center",
          gap: SPACE.sm,
          padding: `${SPACE.sm}px ${SPACE.md}px`,
          cursor: file.binary ? "default" : "pointer",
          background: isViewed ? "var(--color-bg-secondary)" : "var(--color-bg-elevated)",
          opacity: isViewed ? 0.6 : 1,
        }}
      >
        <span style={{ width: 16, textAlign: "center", fontSize: 11, fontWeight: 700, color: STATUS_COLOR[file.status], flexShrink: 0 }}>
          {STATUS_LETTER[file.status]}
        </span>
        <span style={{ fontWeight: 600, fontSize: TEXT.sm, flexShrink: 0 }}>{name}</span>
        <span
          style={{
            color: "var(--color-text-muted)",
            fontSize: TEXT.xs,
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {dir}
        </span>
        {file.binary ? (
          <span style={{ fontSize: TEXT.xs, color: "var(--color-text-muted)", flexShrink: 0 }}>binary</span>
        ) : (
          <span style={{ fontSize: TEXT.xs, fontFamily: '"IBM Plex Mono", Menlo, Monaco, monospace', flexShrink: 0 }}>
            {file.additions != null && <span style={{ color: "var(--color-status-working)" }}>+{file.additions} </span>}
            {file.deletions != null && <span style={{ color: "var(--color-error)" }}>-{file.deletions}</span>}
          </span>
        )}
        <label
          onClick={(e) => e.stopPropagation()}
          style={{ display: "flex", alignItems: "center", gap: 4, fontSize: TEXT.xs, color: "var(--color-text-muted)", flexShrink: 0 }}
        >
          <input type="checkbox" checked={isViewed} onChange={onToggleViewed} /> Viewed
        </label>
      </div>
      {isExpanded && file.binary && (
        <div style={{ padding: SPACE.md, fontSize: TEXT.sm, color: "var(--color-text-muted)" }}>Binary file not shown.</div>
      )}
      {isExpanded && !file.binary && isLarge && !isForceExpanded && (
        <div style={{ padding: SPACE.md, fontSize: TEXT.sm, color: "var(--color-text-muted)", textAlign: "center" }}>
          File not expanded by default (large diff, {linesChanged} lines changed) ·{" "}
          <button
            onClick={onForceExpand}
            style={{ background: "none", border: "none", color: "var(--color-accent)", cursor: "pointer", padding: 0, fontSize: TEXT.sm }}
          >
            Expand
          </button>
        </div>
      )}
      {shouldRenderDiff && <FileDiff cwd={cwd} hash={hash} path={file.path} />}
    </div>
  );
}

/** Fetches this one commit-vs-parent file's content lazily (only once
 * actually expanded — see FileRow) via getFileDiffContent, then hands it to
 * the shared MonacoFileDiff for rendering — this component owns just the
 * fetch/loading state, not the Monaco lifecycle itself (see
 * MonacoFileDiff.tsx, extracted from what used to live here directly so
 * GitPanel.tsx's Changes tab can reuse the same rendering for uncommitted
 * changes without duplicating the whole Monaco mount/dispose/theme setup). */
function FileDiff({ cwd, hash, path }: { cwd: string; hash: string; path: string }) {
  const [content, setContent] = useState<FileDiffContent | null>(null);

  useEffect(() => {
    let disposed = false;
    setContent(null);
    void window.metaharnFiles.getFileDiffContent(cwd, hash, path).then((c) => {
      if (!disposed) setContent(c);
    });
    return () => {
      disposed = true;
    };
  }, [cwd, hash, path]);

  if (!content) {
    return (
      <div
        style={{
          height: 160,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--color-text-muted)",
          fontSize: TEXT.sm,
          borderTop: "1px solid var(--color-border)",
          background: "var(--color-editor-bg)",
        }}
      >
        Loading diff…
      </div>
    );
  }

  return <MonacoFileDiff oldContent={content.oldContent} newContent={content.newContent} path={path} />;
}
