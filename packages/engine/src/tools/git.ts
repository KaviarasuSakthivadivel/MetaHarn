/**
 * `git_log` — recent commit history for context (read-only).
 *
 * Complements a filesystem-level `git_diff`/`git_status` tool (owned elsewhere) by letting
 * the agent see how a file came to be the way it is before changing it. Read-only; no
 * commit/push here — those go through a shell/exec tool, gated by that tool's own risk class.
 *
 * Ported from OpenWorker's coworker/tools/git.py.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpathSync } from "node:fs";
import * as path from "node:path";
import type { ToolDefinition, ToolSchema } from "../types.js";

const execFileAsync = promisify(execFile);

// Unit separator — won't appear in author names/subjects, so splitting the pretty-format
// line back apart can't be confused by a colon or pipe in a commit message.
const SEP = "\x1f";

const GIT_LOG_SCHEMA: ToolSchema = {
  type: "function",
  function: {
    name: "git_log",
    description:
      "Recent git commit history (hash, author, date, subject). Optionally scope to a path. " +
      "Use it to understand how code evolved before editing. Read-only.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Optional file/dir to scope history to." },
        max_count: { type: "integer", description: "How many commits (default 20, max 200)." },
      },
    },
  },
};

interface GitCommit {
  hash: string;
  author: string;
  date: string;
  subject: string;
}

export function createGitLogTool(workspace: string): ToolDefinition {
  // Resolved once at registration time, same as the Python factory's `root`.
  let root: string;
  try {
    root = realpathSync(path.resolve(workspace));
  } catch {
    root = path.resolve(workspace);
  }

  return {
    name: "git_log",
    schema: GIT_LOG_SCHEMA,
    metadata: { category: "git", riskLevel: "low", risk: "read", requiresApproval: false, capabilities: ["git"] },
    execute: async (args, ctx) => {
      const rawMax = args.max_count;
      const n = Math.min(typeof rawMax === "number" && Number.isFinite(rawMax) && rawMax > 0 ? Math.floor(rawMax) : 20, 200);
      const scopePath = typeof args.path === "string" && args.path.length > 0 ? args.path : undefined;

      const cmdArgs = ["-C", root, "log", `-n${n}`, `--pretty=format:%h${SEP}%an${SEP}%ad${SEP}%s`, "--date=short"];
      if (scopePath) cmdArgs.push("--", scopePath);

      try {
        const { stdout } = await execFileAsync("git", cmdArgs, { timeout: 15_000, maxBuffer: 10 * 1024 * 1024, signal: ctx.signal });
        const commits: GitCommit[] = [];
        for (const line of stdout.split("\n")) {
          if (!line) continue;
          const parts = line.split(SEP);
          if (parts.length === 4) {
            commits.push({ hash: parts[0], author: parts[1], date: parts[2], subject: parts[3] });
          }
        }
        return { count: commits.length, commits };
      } catch (err) {
        const e = err as NodeJS.ErrnoException & { stderr?: string };
        return { error: (e.stderr || e.message || "git log failed").trim().slice(0, 300) };
      }
    },
  };
}
