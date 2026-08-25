import { readdirSync, readFileSync, writeFileSync, type Dirent } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { parseGitStatusPorcelain, type GitFileStatus } from "./git.js";

export type { GitFileStatus };

const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", ".next", "build", ".turbo", ".vite"]);
const MAX_DEPTH = 8;
const MAX_ENTRIES = 3000;

export interface FileTreeNode {
  name: string;
  path: string; // relative to root, forward-slash separated
  isDirectory: boolean;
  children?: FileTreeNode[];
  /** Only ever set on files, never directories (no aggregation up the tree
   * in this v0 — the highest-signal use case, "what did the agent just
   * touch," is already served by per-file status alone). Absent entirely
   * for a clean file, or when `root` isn't a git repo / git isn't on PATH —
   * same "missing means nothing to report" contract as everywhere else
   * git-derived data shows up in this app. */
  gitStatus?: GitFileStatus;
}

/**
 * `git status --porcelain` output, one call per tree fetch — cheap for a
 * repo-sized worktree and avoids needing a persistent watcher just to
 * answer "what changed." Never throws: not a git repo, git not installed,
 * or any other failure just means no status data, not a crashed file tree.
 */
function getGitStatusMap(root: string): Map<string, GitFileStatus> {
  const map = new Map<string, GitFileStatus>();
  let output: string;
  try {
    output = execSync("git status --porcelain", { cwd: root, encoding: "utf-8" });
  } catch {
    return map;
  }
  for (const { path: relPath, status } of parseGitStatusPorcelain(output)) {
    map.set(relPath, status);
  }
  return map;
}

/**
 * Resolves `relPath` against `root` and throws if the result would land
 * outside `root` — the Files tab exposes real filesystem read/write over
 * IPC, so this guard matters even for a v0 single-user desktop app.
 */
function resolveWithinRoot(root: string, relPath: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relPath);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`Path escapes project root: ${relPath}`);
  }
  return resolved;
}

export function listDirectoryTree(root: string): FileTreeNode[] {
  let count = 0;
  const gitStatus = getGitStatusMap(root);

  function walk(dir: string, relDir: string, depth: number): FileTreeNode[] {
    if (depth > MAX_DEPTH || count >= MAX_ENTRIES) return [];
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter((e) => !e.name.startsWith(".") || e.name === ".github")
        .filter((e) => !IGNORE_DIRS.has(e.name))
        .sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
    } catch {
      return [];
    }

    const nodes: FileTreeNode[] = [];
    for (const entry of entries) {
      if (count >= MAX_ENTRIES) break;
      count++;
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      const isDirectory = entry.isDirectory();
      nodes.push({
        name: entry.name,
        path: relPath,
        isDirectory,
        children: isDirectory ? walk(path.join(dir, entry.name), relPath, depth + 1) : undefined,
        gitStatus: isDirectory ? undefined : gitStatus.get(relPath),
      });
    }
    return nodes;
  }

  return walk(path.resolve(root), "", 0);
}

export function readProjectFile(root: string, relPath: string): string {
  return readFileSync(resolveWithinRoot(root, relPath), "utf-8");
}

export function writeProjectFile(root: string, relPath: string, content: string): void {
  writeFileSync(resolveWithinRoot(root, relPath), content, "utf-8");
}
