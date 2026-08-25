import { execFileSync, execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Current branch name for `cwd`, or null if it's not a git repo (or has no commits yet). */
export function getCurrentBranch(cwd: string): string | null {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", { cwd, encoding: "utf-8" }).trim() || null;
  } catch {
    return null;
  }
}

/** Working-tree cleanliness for `cwd` — "dirty" on any uncommitted change
 * (staged, unstaged, or untracked), null if it's not a git repo. Used for
 * the worktree cards on ProjectOverview.tsx (real `git status`, not a
 * guess). */
export function getGitStatus(cwd: string): "clean" | "dirty" | null {
  try {
    const output = execSync("git status --porcelain", { cwd, encoding: "utf-8" }).trim();
    return output ? "dirty" : "clean";
  } catch {
    return null;
  }
}

export type GitFileStatus = "modified" | "added" | "deleted" | "untracked" | "renamed";

export interface GitChange {
  path: string;
  status: GitFileStatus;
}

/**
 * Shared `git status --porcelain` parser — the one place this codebase
 * decides what a porcelain status line means. `files.ts`'s per-file tree
 * annotations and `getGitChanges` below both build on this instead of each
 * re-deriving the same status-char mapping independently.
 */
export function parseGitStatusPorcelain(output: string): GitChange[] {
  const results: GitChange[] = [];
  for (const line of output.split("\n")) {
    if (!line) continue;
    const indexStatus = line[0];
    const worktreeStatus = line[1];
    let relPath = line.slice(3);
    // Renames are reported as "old/path -> new/path" — only the current
    // (new) path is useful to a caller asking "what changed."
    const arrowIdx = relPath.indexOf(" -> ");
    if (arrowIdx !== -1) relPath = relPath.slice(arrowIdx + 4);

    let status: GitFileStatus;
    if (indexStatus === "?" || worktreeStatus === "?") status = "untracked";
    else if (indexStatus === "R" || worktreeStatus === "R") status = "renamed";
    else if (indexStatus === "A" || worktreeStatus === "A") status = "added";
    else if (indexStatus === "D" || worktreeStatus === "D") status = "deleted";
    else status = "modified";

    results.push({ path: relPath, status });
  }
  return results;
}

/**
 * Every uncommitted change in `cwd`, as a real list — not a diff, just
 * which files and how (see `GitFileStatus`). Used by the Git panel's
 * Changes tab and the worktree-removal confirmation (so deleting a dirty
 * worktree is an informed choice, not a surprise). Cheap even on a big
 * working tree: one `git status --porcelain` call, no per-file `git diff`.
 */
export function getGitChanges(cwd: string): GitChange[] | null {
  try {
    const output = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf-8" });
    return parseGitStatusPorcelain(output);
  } catch {
    return null;
  }
}

export interface GitLogEntry {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: string;
  refs: string[];
  /** Parent commit hashes, in parent order — empty for a root commit, 2+ for
   * a merge commit. Powers the commit-graph lane/line rendering in
   * GitPanel.tsx's Log tab and BranchExplorer.tsx (see graphLayout.ts). */
  parents: string[];
}

// \x1f (unit separator) / \x1e (record separator) — git's --pretty=format
// inserts these verbatim, and neither can appear in a commit subject line,
// so splitting on them is unambiguous (a naive "|"/"," split is not: commit
// messages routinely contain both).
const FIELD_SEP = "\x1f";
const RECORD_SEP = "\x1e";

/**
 * Paginated commit log for `cwd` — `--max-count`/`--skip` are mandatory on
 * every call (not optional flourishes): a mono repo can carry hundreds of
 * thousands of commits, and this function must never be asked to walk all
 * of them. `branch` scopes to one ref instead of the checked-out HEAD; a
 * plain array (`git log` output, not the full history) either way. `null`
 * means not a git repo (or git isn't on PATH), matching every other
 * function in this file's error contract.
 */
export function getGitLog(cwd: string, skip: number, limit: number, branch?: string): GitLogEntry[] | null {
  try {
    const args = [
      "log",
      ...(branch ? [branch] : []),
      `--max-count=${limit}`,
      `--skip=${skip}`,
      `--pretty=format:%H${FIELD_SEP}%h${FIELD_SEP}%s${FIELD_SEP}%an${FIELD_SEP}%aI${FIELD_SEP}%D${FIELD_SEP}%P${RECORD_SEP}`,
    ];
    const output = execFileSync("git", args, { cwd, encoding: "utf-8" });
    return output
      .split(RECORD_SEP)
      .map((record) => record.replace(/^\n/, ""))
      .filter((record) => record.length > 0)
      .map((record) => {
        const [hash, shortHash, message, author, date, refs, parents] = record.split(FIELD_SEP);
        return {
          hash,
          shortHash,
          message,
          author,
          date,
          refs: refs ? refs.split(",").map((r) => r.trim()).filter(Boolean) : [],
          parents: parents ? parents.trim().split(/\s+/).filter(Boolean) : [],
        };
      });
  } catch {
    return null;
  }
}

export interface GitBranchInfo {
  name: string;
  isCurrent: boolean;
  lastCommitDate: string;
}

/**
 * Every local branch, most-recently-committed first — `--count` is
 * mandatory here too, same reasoning as `getGitLog`: a repo with thousands
 * of branches must never be enumerated without a cap. `limit` defaults to
 * a generous 300, well past what any UI reasonably renders as chips/rows at
 * once (see BranchExplorer.tsx / GitPanel.tsx).
 */
export function getGitBranches(cwd: string, limit = 300): GitBranchInfo[] | null {
  try {
    const output = execFileSync(
      "git",
      [
        "for-each-ref",
        "refs/heads",
        "--sort=-committerdate",
        `--count=${limit}`,
        `--format=%(refname:short)${FIELD_SEP}%(HEAD)${FIELD_SEP}%(committerdate:iso-strict)`,
      ],
      { cwd, encoding: "utf-8" },
    );
    return output
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => {
        const [name, head, lastCommitDate] = line.split(FIELD_SEP);
        return { name, isCurrent: head === "*", lastCommitDate };
      });
  } catch {
    return null;
  }
}

export interface BranchInfo {
  name: string;
  isCurrent: boolean;
  lastCommitDate: string;
  ahead: number;
  behind: number;
}

/**
 * Richer sibling of `getGitBranches` — adds ahead/behind-vs-HEAD counts,
 * for the Branches tab's `↑N`/`↓N` indicators. Still one `for-each-ref`
 * call, not one `git rev-list --count` per branch — a repo with thousands
 * of branches must stay O(1) git process spawns here, not O(n); the
 * `%(ahead-behind:HEAD)` atom (git >= 2.31) computes every branch's
 * ahead/behind against HEAD server-side, in the same call as the name/
 * current/date fields `getGitBranches` already fetches.
 */
export function getGitBranchesDetailed(cwd: string, limit = 300): BranchInfo[] | null {
  try {
    const output = execFileSync(
      "git",
      [
        "for-each-ref",
        "refs/heads",
        "--sort=-committerdate",
        `--count=${limit}`,
        `--format=%(refname:short)${FIELD_SEP}%(HEAD)${FIELD_SEP}%(committerdate:iso-strict)${FIELD_SEP}%(ahead-behind:HEAD)`,
      ],
      { cwd, encoding: "utf-8" },
    );
    return output
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => {
        const [name, head, lastCommitDate, aheadBehind] = line.split(FIELD_SEP);
        const [ahead, behind] = (aheadBehind ?? "0 0").trim().split(/\s+/).map(Number);
        return { name, isCurrent: head === "*", lastCommitDate, ahead: ahead || 0, behind: behind || 0 };
      });
  } catch {
    return null;
  }
}

export interface RemoteBranchInfo {
  remote: string;
  name: string;
}

/** Read-only remote-tracking ref listing — no fetch/pull, nothing here
 * talks to a network, just lists what's already known locally. `--count`
 * capped for the same reason `getGitBranchesDetailed` caps local branches. */
export function getGitRemoteBranches(cwd: string, limit = 100): RemoteBranchInfo[] | null {
  try {
    // Filtering on the FULL refname, not the short one: a remote's symbolic
    // HEAD pointer (refs/remotes/origin/HEAD) short-forms to just "origin"
    // — no "/HEAD" suffix survives to filter on there — but the full
    // refname always keeps it, so that's the one this checks against
    // (confirmed by reproduction: an earlier version of this function
    // filtered on the short name and let a bare "origin" row through).
    const output = execFileSync(
      "git",
      ["for-each-ref", "refs/remotes", `--count=${limit}`, `--format=%(refname:short)${FIELD_SEP}%(refname)`],
      { cwd, encoding: "utf-8" },
    );
    return output
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => line.split(FIELD_SEP))
      .filter(([, fullRef]) => !fullRef.endsWith("/HEAD"))
      .map(([name]) => ({ remote: name.split("/")[0], name }));
  } catch {
    return null;
  }
}

/** Creates a new local branch from HEAD and switches to it in one step
 * (`checkout -b`) — matches every mainstream git GUI's default "New
 * branch" behavior. Real error propagates uncaught (invalid name, already
 * exists), same pattern as every other git call in this file. */
export function createBranch(cwd: string, name: string): void {
  execFileSync("git", ["checkout", "-b", name], { cwd, encoding: "utf-8" });
}

/**
 * Deletes a local branch — `-d` (safe, refuses an unmerged branch) unless
 * `force`, which uses `-D`. This function doesn't decide when to force;
 * the Branches tab (GitPanel.tsx) calls it with `force: false` first, and
 * only retries with `force: true` after a real "not fully merged" error
 * and a second explicit confirmation — same two-step review pattern
 * `removeWorktree`'s caller already uses for uncommitted changes, applied
 * here to unmerged commits instead.
 */
export function deleteBranch(cwd: string, name: string, force: boolean): void {
  execFileSync("git", ["branch", force ? "-D" : "-d", name], { cwd, encoding: "utf-8" });
}

/**
 * Switches the checked-out branch in `cwd`. Deliberately never forced —
 * unlike `removeWorktree` below, the user hasn't asked for this to succeed
 * "for any reason": if git refuses (uncommitted changes would be
 * overwritten), the real error propagates uncaught, same as every other
 * git call in this file. The Branches tab (GitPanel.tsx) surfaces it via
 * `alert()`, this codebase's existing convention for a failed mutation.
 */
export function checkoutBranch(cwd: string, branch: string): void {
  execFileSync("git", ["checkout", branch], { cwd, encoding: "utf-8" });
}

/** Header info for the commit-diff window — subject, author, date, nothing
 * that needs pagination. Same delimiter/parsing convention as getGitLog. */
export interface CommitMeta {
  hash: string;
  message: string;
  author: string;
  date: string;
}

export function getCommitMeta(cwd: string, hash: string): CommitMeta | null {
  try {
    const output = execFileSync(
      "git",
      ["show", "--no-patch", `--format=%H${FIELD_SEP}%s${FIELD_SEP}%an${FIELD_SEP}%aI`, hash],
      { cwd, encoding: "utf-8" },
    ).trim();
    const [fullHash, message, author, date] = output.split(FIELD_SEP);
    return { hash: fullHash, message, author, date };
  } catch {
    return null;
  }
}

export type CommitFileStatus = "added" | "modified" | "deleted" | "renamed";

export interface CommitFileEntry {
  path: string;
  status: CommitFileStatus;
  additions: number | null; // null for binary files
  deletions: number | null;
  binary: boolean;
}

export interface CommitFileList {
  files: CommitFileEntry[];
  totalCount: number;
  truncated: boolean;
}

const MAX_COMMIT_FILES = 2000;

/**
 * Every file a single commit touched, real stats, real status — capped
 * hard at MAX_COMMIT_FILES (a mono repo commit can genuinely touch
 * thousands of files, e.g. a mass rename or vendor bump; this must never
 * hand the renderer an unbounded list). `totalCount` is the real total
 * before capping, `truncated` says whether the cap actually bit — this
 * backs the "Showing first N of totalCount files" banner in the commit
 * diff window. Two git calls, not one: `--numstat` gives real add/delete
 * counts (with "-" for binary, mapped to null+binary:true below) but not
 * rename detection the way `--name-status` reports it, so both are run
 * and merged by path.
 */
export function getCommitFileList(cwd: string, hash: string): CommitFileList | null {
  try {
    const numstatOutput = execFileSync("git", ["show", "--numstat", "--format=", hash], { cwd, encoding: "utf-8" });
    const nameStatusOutput = execFileSync("git", ["show", "--name-status", "--format=", hash], {
      cwd,
      encoding: "utf-8",
    });

    const statusByPath = new Map<string, CommitFileStatus>();
    for (const line of nameStatusOutput.split("\n")) {
      if (!line) continue;
      const [code, ...rest] = line.split("\t");
      // Renames report as "R100\told\tnew" — the new path is what numstat
      // also reports as the file's path, so that's the one to key on.
      const path = rest[rest.length - 1];
      if (!path) continue;
      let status: CommitFileStatus;
      if (code.startsWith("A")) status = "added";
      else if (code.startsWith("D")) status = "deleted";
      else if (code.startsWith("R")) status = "renamed";
      else status = "modified";
      statusByPath.set(path, status);
    }

    const allFiles: CommitFileEntry[] = [];
    for (const line of numstatOutput.split("\n")) {
      if (!line) continue;
      const [addStr, delStr, path] = line.split("\t");
      if (!path) continue;
      const binary = addStr === "-" || delStr === "-";
      allFiles.push({
        path,
        status: statusByPath.get(path) ?? "modified",
        additions: binary ? null : Number(addStr),
        deletions: binary ? null : Number(delStr),
        binary,
      });
    }

    const totalCount = allFiles.length;
    const files = allFiles.slice(0, MAX_COMMIT_FILES);
    return { files, totalCount, truncated: totalCount > files.length };
  } catch {
    return null;
  }
}

/**
 * A single file's before/after content at `hash`, for the commit diff
 * window's per-file (lazy, expand-on-demand) diff view — never fetched for
 * every file up front, only when a row is actually expanded, so opening a
 * commit with hundreds of files stays cheap. `oldContent`/`newContent` are
 * independent lookups: a file added at this commit has no "before"
 * (oldContent: null), one deleted here has no "after" (newContent: null),
 * and both failing independently is expected, not an error to throw on.
 */
export function getFileDiffContent(cwd: string, hash: string, path: string): { oldContent: string | null; newContent: string | null } {
  let newContent: string | null;
  try {
    newContent = execFileSync("git", ["show", `${hash}:${path}`], { cwd, encoding: "utf-8" });
  } catch {
    newContent = null;
  }
  let oldContent: string | null;
  try {
    oldContent = execFileSync("git", ["show", `${hash}^:${path}`], { cwd, encoding: "utf-8" });
  } catch {
    oldContent = null;
  }
  return { oldContent, newContent };
}

/**
 * A single uncommitted change's before/after content — the Changes tab's
 * equivalent of getFileDiffContent above, but HEAD-vs-working-tree instead
 * of commit-vs-parent. `oldContent` is still a real git lookup (`git show
 * HEAD:path`, null for a newly added/untracked file with nothing at HEAD);
 * `newContent` is NOT a git call at all — the whole point of an uncommitted
 * change is that it isn't in git yet, so this reads the real file straight
 * off disk (null if the file was deleted from the working tree, whether or
 * not that deletion is itself staged). `path` is repo-root-relative, same
 * convention `getGitChanges`'s porcelain output already uses — every git.ts
 * function treats `cwd` as the repo root itself (never a subdirectory), so
 * a plain join is correct here, not an approximation.
 */
export function getWorkingFileDiff(cwd: string, path: string): { oldContent: string | null; newContent: string | null } {
  let oldContent: string | null;
  try {
    oldContent = execFileSync("git", ["show", `HEAD:${path}`], { cwd, encoding: "utf-8" });
  } catch {
    oldContent = null;
  }
  let newContent: string | null;
  try {
    newContent = readFileSync(join(cwd, path), "utf-8");
  } catch {
    newContent = null;
  }
  return { oldContent, newContent };
}

/**
 * Real `git worktree remove --force`, run from the PARENT checkout (the
 * worktree being removed is not a valid `cwd` to run this from). Always
 * forced — the safety net here is the confirmation UI showing the real
 * uncommitted-changes list before this is ever called (see
 * ipc.ts's metaharn:removeWorktreeSession), not git's own dirty-worktree
 * refusal. Lets a real git error (bad path, locked worktree, etc.)
 * propagate uncaught, same pattern as every other git call in this file
 * and in worktree.ts's createWorktree.
 */
export function removeWorktree(parentCwd: string, worktreePath: string): void {
  execFileSync("git", ["worktree", "remove", "--force", worktreePath], { cwd: parentCwd, encoding: "utf-8" });
}
