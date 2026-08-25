import { useEffect, useRef, useState } from "react";
import type { BranchInfo, FileDiffContent, GitChange, GitFileStatus, GitLogEntry, RemoteBranchInfo, WorktreeLink } from "../preload/preload.js";
import { formatRelativeTime } from "./format.js";
import { BranchIcon, ClockIcon, PlusIcon, TrashIcon } from "./icons.js";
import { IconButton } from "./Sidebar.js";
import { RADIUS, SPACE, TEXT } from "./ui.js";
import { CommitGraph, LOG_ROW_GAP, LOG_ROW_HEIGHT } from "./CommitGraph.js";
import MonacoFileDiff from "./MonacoFileDiff.js";

interface GitPanelProps {
  cwd: string;
  worktreeLinks: WorktreeLink[];
  onClose: () => void;
  onOpenBranchExplorer: (branch?: string) => void;
  /** Shared confirm-dialog primitive (App.tsx's pendingConfirm/setPendingConfirm)
   * — lets this panel own its own destructive-action flow (branch delete,
   * same two-step force-on-real-failure pattern the worktree-remove flow
   * already established) without App.tsx needing to know branch specifics. */
  requestConfirm: (opts: { message: string; details?: React.ReactNode; onConfirm: () => void }) => void;
}

type Tab = "changes" | "branches" | "log";

const LOG_PAGE_SIZE = 50;

const STATUS_COLOR: Record<GitFileStatus, string> = {
  added: "var(--color-status-working)",
  modified: "var(--color-status-waiting)",
  deleted: "var(--color-error)",
  untracked: "var(--color-text-muted)",
  renamed: "var(--color-text-muted)",
};

/**
 * Right-side Changes/Branches/Log panel — one top-level toggle opens/closes
 * it (see App.tsx's showGitPanel/toggleGitPanel), no per-tab open state.
 * Every tab fetches lazily (only when it's the active one, not all three on
 * mount) and every git call behind it is already capped server-side (see
 * git.ts's getGitLog/getGitBranchesDetailed doc comments) — this panel
 * never asks for more than a page of anything, which matters for a big
 * mono repo. Widened from the original 360px to better match the amount
 * of real branch metadata (ahead/behind, worktree status, hover actions,
 * a Remote section) the Branches tab now carries.
 */
export default function GitPanel({ cwd, worktreeLinks, onClose, onOpenBranchExplorer, requestConfirm }: GitPanelProps) {
  const [branch, setBranch] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("log");
  const [changes, setChanges] = useState<GitChange[] | null | undefined>(undefined);
  const [branches, setBranches] = useState<BranchInfo[] | null | undefined>(undefined);
  const [remoteBranches, setRemoteBranches] = useState<RemoteBranchInfo[] | null | undefined>(undefined);
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);
  const [log, setLog] = useState<GitLogEntry[]>([]);
  const [logSkip, setLogSkip] = useState(0);
  const [logHasMore, setLogHasMore] = useState(true);
  const [logLoading, setLogLoading] = useState(false);
  // React state updates aren't synchronous (and dev-mode StrictMode
  // double-invokes effects on mount) — a `logLoading` STATE check in the
  // effect below isn't enough to stop two fetches of the same page landing
  // back to back, which duplicated every commit in the list. A ref flips
  // synchronously, so the second call actually sees the first one in
  // flight and bails out instead.
  const logFetchInFlight = useRef(false);

  useEffect(() => {
    void window.metaharnFiles.getGitBranch(cwd).then(setBranch);
  }, [cwd]);

  useEffect(() => {
    if (tab === "changes" && changes === undefined) {
      void window.metaharnFiles.getGitChanges(cwd).then(setChanges);
    } else if (tab === "branches" && branches === undefined) {
      void window.metaharnFiles.getGitBranchesDetailed(cwd).then(setBranches);
      void window.metaharnFiles.getGitRemoteBranches(cwd).then(setRemoteBranches);
    } else if (tab === "log" && log.length === 0 && logHasMore) {
      loadMoreLog();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, cwd]);

  const refreshBranches = () => {
    void window.metaharnFiles.getGitBranchesDetailed(cwd).then(setBranches);
    void window.metaharnFiles.getGitRemoteBranches(cwd).then(setRemoteBranches);
  };

  /** Never forced (see git.ts's checkoutBranch doc comment) — a real
   * failure (uncommitted changes blocking it) surfaces via alert(), this
   * codebase's existing convention for a failed mutation elsewhere. */
  const switchBranch = (name: string) => {
    setSwitchingTo(name);
    window.metaharn
      .checkoutBranch(cwd, name)
      .then(() => {
        setBranch(name);
        refreshBranches();
      })
      .catch((err: Error) => alert(`Couldn't switch branches: ${err.message}`))
      .finally(() => setSwitchingTo(null));
  };

  const createBranch = (name: string) => {
    window.metaharn
      .createBranch(cwd, name)
      .then(() => {
        setBranch(name);
        refreshBranches();
      })
      .catch((err: Error) => alert(`Couldn't create branch: ${err.message}`));
  };

  /**
   * Two-step delete, mirroring the worktree-removal flow's own
   * review-then-force pattern: a plain `-d` first (git refuses if the
   * branch isn't fully merged), and only on that SPECIFIC real failure
   * does a second confirmation offer `-D`. Any other failure (e.g. a
   * worktree still has it checked out) is surfaced as-is, not retried —
   * force-deleting past THAT kind of failure is a different, worse
   * situation than an unmerged-commits one.
   */
  const deleteBranchFlow = (name: string) => {
    requestConfirm({
      message: `Delete branch "${name}"? This cannot be undone.`,
      onConfirm: () => {
        window.metaharn
          .deleteBranch(cwd, name, false)
          .then(refreshBranches)
          .catch((err: Error) => {
            if (err.message.includes("not fully merged")) {
              requestConfirm({
                message: `"${name}" has unmerged commits that would be lost. Force delete anyway?`,
                onConfirm: () => {
                  window.metaharn
                    .deleteBranch(cwd, name, true)
                    .then(refreshBranches)
                    .catch((forceErr: Error) => alert(`Couldn't delete branch: ${forceErr.message}`));
                },
              });
            } else {
              alert(`Couldn't delete branch: ${err.message}`);
            }
          });
      },
    });
  };

  const loadMoreLog = () => {
    if (logFetchInFlight.current) return;
    logFetchInFlight.current = true;
    setLogLoading(true);
    void window.metaharnFiles.getGitLog(cwd, logSkip, LOG_PAGE_SIZE).then((page) => {
      logFetchInFlight.current = false;
      setLogLoading(false);
      if (!page) {
        setLogHasMore(false);
        return;
      }
      setLog((prev) => [...prev, ...page]);
      setLogSkip((s) => s + page.length);
      if (page.length < LOG_PAGE_SIZE) setLogHasMore(false);
    });
  };

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: `${SPACE.md}px ${SPACE.md}px 0` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--color-accent)" }}>
          <BranchIcon size={14} />
          <strong style={{ fontSize: TEXT.base, color: "var(--color-text)", fontFamily: '"IBM Plex Mono", Menlo, Monaco, monospace' }}>
            {branch ?? "—"}
          </strong>
        </div>
        <button
          onClick={onClose}
          aria-label="Close git panel"
          className="metaharn-tooltip"
          style={{ border: "none", background: "transparent", color: "var(--color-text-secondary)", cursor: "pointer", fontSize: 16, lineHeight: 1 }}
        >
          ×
        </button>
      </div>

      <div style={{ display: "flex", gap: SPACE.sm, padding: `${SPACE.sm}px ${SPACE.md}px`, borderBottom: "1px solid var(--color-border)" }}>
        {(["changes", "branches", "log"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              border: "none",
              background: "transparent",
              padding: "4px 2px",
              fontSize: TEXT.sm,
              fontWeight: tab === t ? 700 : 400,
              color: tab === t ? "var(--color-text)" : "var(--color-text-muted)",
              borderBottom: tab === t ? "2px solid var(--color-accent)" : "2px solid transparent",
              cursor: "pointer",
              textTransform: "capitalize",
            }}
          >
            {t}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: SPACE.md }}>
        {tab === "changes" && <ChangesTab cwd={cwd} changes={changes} />}
        {tab === "branches" && (
          <BranchesTab
            branches={branches}
            remoteBranches={remoteBranches}
            worktreeLinks={worktreeLinks}
            switchingTo={switchingTo}
            onSwitch={switchBranch}
            onDelete={deleteBranchFlow}
            onCreate={createBranch}
            onViewCommits={(name) => onOpenBranchExplorer(name)}
            onOpenBranchExplorer={() => onOpenBranchExplorer()}
          />
        )}
        {tab === "log" && (
          <LogTab
            cwd={cwd}
            log={log}
            hasMore={logHasMore}
            loading={logLoading}
            onLoadMore={loadMoreLog}
            onOpenBranchExplorer={() => onOpenBranchExplorer()}
          />
        )}
      </div>
    </div>
  );
}

function ChangesTab({ cwd, changes }: { cwd: string; changes: GitChange[] | null | undefined }) {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const toggleExpanded = (path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  if (changes === undefined) return <p style={{ fontSize: TEXT.sm, color: "var(--color-text-muted)" }}>Loading...</p>;
  if (changes === null) return <p style={{ fontSize: TEXT.sm, color: "var(--color-text-muted)" }}>Not a git repository.</p>;
  if (changes.length === 0) {
    return <p style={{ fontSize: TEXT.sm, color: "var(--color-text-muted)" }}>Working tree clean — no uncommitted changes.</p>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {changes.map((c) => (
        <ChangeRow key={c.path} cwd={cwd} change={c} isExpanded={expandedPaths.has(c.path)} onToggle={() => toggleExpanded(c.path)} />
      ))}
    </div>
  );
}

/** One uncommitted change, expandable to a real HEAD-vs-working-tree diff
 * (see git.ts's getWorkingFileDiff) — same accordion/Monaco pattern
 * CommitDiffWindow.tsx's FileRow already established for a commit's files,
 * reusing the shared MonacoFileDiff component rather than a second
 * hand-rolled diff renderer. */
function ChangeRow({
  cwd,
  change,
  isExpanded,
  onToggle,
}: {
  cwd: string;
  change: GitChange;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const [content, setContent] = useState<FileDiffContent | null>(null);

  useEffect(() => {
    if (!isExpanded) return;
    let disposed = false;
    setContent(null);
    void window.metaharnFiles.getWorkingFileDiff(cwd, change.path).then((c) => {
      if (!disposed) setContent(c);
    });
    return () => {
      disposed = true;
    };
  }, [isExpanded, cwd, change.path]);

  return (
    <div style={{ border: "1px solid var(--color-border)", borderRadius: RADIUS.sm, overflow: "hidden" }}>
      <div
        onClick={onToggle}
        className="metaharn-card-row"
        style={{ display: "flex", gap: 8, alignItems: "center", padding: "4px 6px", cursor: "pointer" }}
      >
        <span style={{ width: 62, flexShrink: 0, fontSize: 10.5, color: STATUS_COLOR[change.status] }}>{change.status}</span>
        <span
          style={{
            fontSize: 12,
            fontFamily: '"IBM Plex Mono", Menlo, Monaco, monospace',
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {change.path}
        </span>
      </div>
      {isExpanded &&
        (content ? (
          <MonacoFileDiff oldContent={content.oldContent} newContent={content.newContent} path={change.path} />
        ) : (
          <div
            style={{
              height: 120,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--color-text-muted)",
              fontSize: TEXT.xs,
              borderTop: "1px solid var(--color-border)",
            }}
          >
            Loading diff…
          </div>
        ))}
    </div>
  );
}

/** Green = a linked worktree exists for this branch and its tree is clean;
 * amber = the same, but dirty (uncommitted changes) — same clean/dirty
 * color convention ProjectOverview.tsx's worktree cards already use. No
 * dot at all when no worktree is linked to this branch (most branches, on
 * a typical repo) — never a guessed status. Fetching worktree git-status
 * is bounded by the number of WORKTREES (always small, unlike total
 * branch count), not the number of branches, so this stays cheap even on
 * a repo with thousands of branches. */
function useWorktreeStatusDots(branches: BranchInfo[] | null | undefined, worktreeLinks: WorktreeLink[]) {
  const [statusByBranch, setStatusByBranch] = useState<Map<string, "clean" | "dirty" | null>>(new Map());
  const linkedCwds = worktreeLinks.map((l) => l.cwd).join(",");
  const branchNamesKey = branches?.map((b) => b.name).join(",");

  useEffect(() => {
    if (!branches || branches.length === 0 || worktreeLinks.length === 0) {
      setStatusByBranch(new Map());
      return;
    }
    let cancelled = false;
    const branchNames = new Set(branches.map((b) => b.name));
    const relevant = worktreeLinks.filter((l) => branchNames.has(l.branch));
    Promise.all(relevant.map((l) => window.metaharnFiles.getGitStatus(l.cwd).then((s) => [l.branch, s] as const))).then(
      (results) => {
        if (cancelled) return;
        setStatusByBranch(new Map(results));
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchNamesKey, linkedCwds]);

  return statusByBranch;
}

function BranchesTab({
  branches,
  remoteBranches,
  worktreeLinks,
  switchingTo,
  onSwitch,
  onDelete,
  onCreate,
  onViewCommits,
  onOpenBranchExplorer,
}: {
  branches: BranchInfo[] | null | undefined;
  remoteBranches: RemoteBranchInfo[] | null | undefined;
  worktreeLinks: WorktreeLink[];
  switchingTo: string | null;
  onSwitch: (name: string) => void;
  onDelete: (name: string) => void;
  onCreate: (name: string) => void;
  onViewCommits: (name: string) => void;
  onOpenBranchExplorer: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const statusByBranch = useWorktreeStatusDots(branches, worktreeLinks);

  if (branches === undefined) return <p style={{ fontSize: TEXT.sm, color: "var(--color-text-muted)" }}>Loading...</p>;
  if (branches === null) return <p style={{ fontSize: TEXT.sm, color: "var(--color-text-muted)" }}>Not a git repository.</p>;

  const submitCreate = () => {
    const name = newName.trim();
    if (!name) return;
    onCreate(name);
    setNewName("");
    setCreating(false);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: SPACE.sm }}>
      {creating ? (
        <div style={{ display: "flex", gap: 6 }}>
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitCreate();
              if (e.key === "Escape") {
                setCreating(false);
                setNewName("");
              }
            }}
            placeholder="new-branch-name"
            style={{
              flex: 1,
              minWidth: 0,
              padding: "5px 8px",
              fontSize: TEXT.sm,
              fontFamily: '"IBM Plex Mono", Menlo, Monaco, monospace',
              border: "1px solid var(--color-accent)",
              borderRadius: RADIUS.sm,
              background: "var(--color-bg)",
              color: "var(--color-text)",
            }}
          />
          <button
            onClick={submitCreate}
            className="metaharn-btn-primary"
            style={{ padding: "5px 10px", fontSize: TEXT.sm, borderRadius: RADIUS.sm }}
          >
            Create
          </button>
        </div>
      ) : (
        <button
          onClick={() => setCreating(true)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            width: "100%",
            textAlign: "left",
            border: "1px dashed var(--color-border)",
            borderRadius: RADIUS.sm,
            background: "transparent",
            color: "var(--color-text-secondary)",
            cursor: "pointer",
            padding: "6px 10px",
            fontSize: TEXT.sm,
          }}
        >
          <PlusIcon size={13} /> New branch
        </button>
      )}

      <button
        onClick={onOpenBranchExplorer}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          textAlign: "left",
          border: "1px solid var(--color-border)",
          borderRadius: RADIUS.sm,
          background: "transparent",
          color: "var(--color-text-secondary)",
          cursor: "pointer",
          padding: "6px 10px",
          fontSize: TEXT.sm,
        }}
      >
        ↗ Open branch explorer
      </button>

      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {branches.map((b) => {
          const dot = statusByBranch.get(b.name);
          return (
            <div
              key={b.name}
              className="metaharn-card-row"
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "5px 4px", borderRadius: RADIUS.sm }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                {dot && (
                  <span
                    title={dot === "clean" ? "Worktree: clean" : "Worktree: has uncommitted changes"}
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      flexShrink: 0,
                      background: dot === "clean" ? "var(--color-status-working)" : "var(--color-status-waiting)",
                    }}
                  />
                )}
                <span
                  style={{
                    fontSize: 12.5,
                    fontWeight: b.isCurrent ? 700 : 400,
                    fontFamily: '"IBM Plex Mono", Menlo, Monaco, monospace',
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {b.name}
                </span>
                {b.isCurrent && (
                  <span style={{ fontSize: 10, color: "var(--color-accent)", background: "var(--color-accent-soft)", borderRadius: RADIUS.sm, padding: "1px 5px", flexShrink: 0 }}>
                    current
                  </span>
                )}
                {(b.ahead > 0 || b.behind > 0) && (
                  <span style={{ fontSize: 10.5, color: "var(--color-text-muted)", flexShrink: 0 }}>
                    {b.ahead > 0 && `↑${b.ahead}`} {b.behind > 0 && `↓${b.behind}`}
                  </span>
                )}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
                <span
                  className="metaharn-hover-actions"
                  style={{ display: "flex", alignItems: "center", background: "var(--color-bg-secondary)", borderRadius: RADIUS.sm }}
                >
                  <IconButton title="View commits" onClick={() => onViewCommits(b.name)}>
                    <ClockIcon size={13} />
                  </IconButton>
                  {!b.isCurrent && (
                    <IconButton
                      title={switchingTo === b.name ? "Switching…" : "Checkout"}
                      onClick={() => onSwitch(b.name)}
                    >
                      <BranchIcon size={13} />
                    </IconButton>
                  )}
                  {!b.isCurrent && (
                    <IconButton title="Delete branch" onClick={() => onDelete(b.name)}>
                      <TrashIcon size={13} />
                    </IconButton>
                  )}
                </span>
                <span style={{ fontSize: 10.5, color: "var(--color-text-muted)", width: 58, textAlign: "right" }}>
                  {formatRelativeTime(new Date(b.lastCommitDate))}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {remoteBranches !== undefined && remoteBranches !== null && remoteBranches.length > 0 && (
        <div style={{ marginTop: SPACE.sm }}>
          <div style={{ fontSize: TEXT.xs, fontWeight: 700, letterSpacing: 0.5, color: "var(--color-text-muted)", marginBottom: 4 }}>
            REMOTE ({remoteBranches.length})
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {remoteBranches.map((r) => (
              <span
                key={r.name}
                style={{
                  fontSize: 11.5,
                  fontFamily: '"IBM Plex Mono", Menlo, Monaco, monospace',
                  color: "var(--color-text-muted)",
                  padding: "2px 4px",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {r.name}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function LogTab({
  cwd,
  log,
  hasMore,
  loading,
  onLoadMore,
  onOpenBranchExplorer,
}: {
  cwd: string;
  log: GitLogEntry[];
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
  onOpenBranchExplorer: () => void;
}) {
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: SPACE.sm }}>
        <button
          onClick={onOpenBranchExplorer}
          aria-label="Open full branch explorer"
          className="metaharn-tooltip"
          style={{
            border: "1px solid var(--color-border)",
            borderRadius: RADIUS.sm,
            background: "transparent",
            color: "var(--color-text-secondary)",
            cursor: "pointer",
            padding: "3px 8px",
            fontSize: TEXT.xs,
          }}
        >
          Open full branch explorer ↗
        </button>
      </div>
      {log.length === 0 && !loading && (
        <p style={{ fontSize: TEXT.sm, color: "var(--color-text-muted)" }}>No commits found.</p>
      )}
      {log.length > 0 && (
        <div style={{ display: "flex" }}>
          <CommitGraph commits={log} />
          <div style={{ display: "flex", flexDirection: "column", gap: LOG_ROW_GAP, flex: 1, minWidth: 0 }}>
            {log.map((entry) => (
              <CommitRow key={entry.hash} entry={entry} onOpen={() => void window.metaharn.openCommitDiffWindow(cwd, entry.hash)} />
            ))}
          </div>
        </div>
      )}
      {hasMore && (
        <button
          onClick={onLoadMore}
          disabled={loading}
          style={{
            width: "100%",
            marginTop: SPACE.sm,
            border: "1px dashed var(--color-border)",
            borderRadius: RADIUS.sm,
            background: "transparent",
            color: "var(--color-text-secondary)",
            cursor: loading ? "default" : "pointer",
            padding: "6px 0",
            fontSize: TEXT.sm,
          }}
        >
          {loading ? "Loading..." : "Load more"}
        </button>
      )}
    </div>
  );
}

/** `onOpen`, when given, makes the row clickable — opens the full commit
 * diff in its own window (see CommitDiffWindow.tsx / main.ts's
 * createCommitDiffWindow). Optional so this stays usable anywhere a plain,
 * non-interactive commit row is enough. Fixed height (LOG_ROW_HEIGHT) so
 * CommitGraph.tsx's lane lines stay aligned with their rows. */
export function CommitRow({ entry, onOpen }: { entry: GitLogEntry; onOpen?: () => void }) {
  return (
    <div
      onClick={onOpen}
      style={{
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 2,
        height: LOG_ROW_HEIGHT,
        overflow: "hidden",
        cursor: onOpen ? "pointer" : undefined,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span style={{ fontSize: 11, color: "var(--color-text-muted)", fontFamily: '"IBM Plex Mono", Menlo, Monaco, monospace', flexShrink: 0 }}>
          {entry.shortHash}
        </span>
        <span
          style={{
            fontSize: 12.5,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
          }}
        >
          {entry.message}
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, overflow: "hidden", whiteSpace: "nowrap" }}>
        {entry.refs.map((ref) => (
          <span
            key={ref}
            style={{
              fontSize: 10,
              color: "var(--color-accent)",
              background: "var(--color-accent-soft)",
              borderRadius: RADIUS.sm,
              padding: "0 5px",
              flexShrink: 0,
            }}
          >
            {ref}
          </span>
        ))}
        <span style={{ fontSize: 10.5, color: "var(--color-text-muted)", flexShrink: 0 }}>{formatRelativeTime(new Date(entry.date))}</span>
      </div>
    </div>
  );
}
