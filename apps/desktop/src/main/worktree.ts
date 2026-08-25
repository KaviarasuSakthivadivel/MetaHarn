import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

export interface WorktreeResult {
  worktreePath: string;
  branch: string;
}

/**
 * Creates a real `git worktree` — a second, independent checkout on disk
 * with its own branch — as a sibling directory of `parentCwd`, not nested
 * inside it (avoids gitignore/build-tool confusion a nested checkout would
 * cause). Uses a `<repo>-worktree-<slug>` naming convention. The branch
 * name is auto-generated, not prompted for
 * — this stays a true one-click action from a session's hover menu, the
 * same one-click spirit as the existing quick-launch terminal session.
 *
 * `git worktree add` genuinely fails on a real repo in real ways (dirty
 * enough state, not a git repo at all, branch name collision) — this
 * doesn't swallow those; the caller surfaces the real git error rather
 * than a generic failure, same pattern as every other main-process git
 * call in this codebase (see git.ts's getCurrentBranch).
 */
export function createWorktree(parentCwd: string): WorktreeResult {
  const branch = `session-${randomBytes(3).toString("hex")}`;
  const worktreePath = `${parentCwd}-worktree-${branch}`;
  execFileSync("git", ["worktree", "add", worktreePath, "-b", branch], { cwd: parentCwd, encoding: "utf-8" });
  return { worktreePath, branch };
}
