/**
 * Fast code search (`grep`) — ripgrep when available, a manual recursive walk otherwise.
 *
 * ripgrep respects `.gitignore` and skips node_modules/target/dist automatically; the
 * fallback walk skips a hardcoded set of the same heavy dirs so behavior stays close
 * regardless of which path is taken. Read-only, workspace-scoped. Returns file:line:text.
 *
 * Ported from OpenWorker's coworker/tools/search.py.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpathSync, realpath as realpathAsync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import type { ToolDefinition, ToolSchema } from "../types.js";

const execFileAsync = promisify(execFile);
const realpath = promisify(realpathAsync);

/**
 * Per-OS application-data directories. Not build noise: on macOS 14+ merely *descending*
 * into ~/Library/Application Support (other apps' containers) trips the App Data TCC
 * protection and macOS shows an alarming "would like to access data from other apps"
 * prompt the user never asked for — reachable whenever the workspace is a home directory.
 * Never traversed; a workspace that itself lives under one of these is still searched
 * normally, since the guard matches directory NAMES encountered mid-walk, not path prefixes.
 */
const IGNORE_DIRS = new Set([
  ".git",
  "node_modules",
  "target",
  "dist",
  "build",
  ".venv",
  "venv", // matches the Python source's ignore set, not just the brief's shorthand list
  "__pycache__",
  ".next",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".idea",
  "Library", // macOS
  "AppData", // Windows
  "Application Data", // Windows (legacy junction)
]);

const GREP_SCHEMA: ToolSchema = {
  type: "function",
  function: {
    name: "grep",
    description:
      "Search the workspace for a regular-expression pattern and return matching lines as " +
      "file:line:text. Fast and .gitignore-aware (skips node_modules, build dirs, etc.). " +
      "Prefer this over reading files blindly to locate code. Read-only.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression to search for." },
        path: { type: "string", description: "Subdirectory to search (default: whole workspace)." },
        glob: { type: "string", description: "Optional filename glob filter, e.g. '*.py'." },
        max_results: { type: "integer", description: "Max matches (default 100, max 1000)." },
      },
      required: ["pattern"],
    },
  },
};

interface GrepMatch {
  file: string;
  line: number;
  text: string;
}

/** Cached for the process lifetime — rg's presence on PATH doesn't change mid-run. */
let ripgrepAvailable: Promise<boolean> | undefined;

function hasRipgrep(): Promise<boolean> {
  if (!ripgrepAvailable) {
    ripgrepAvailable = execFileAsync("rg", ["--version"])
      .then(() => true)
      .catch(() => false);
  }
  return ripgrepAvailable;
}

export function createGrepTool(workspace: string): ToolDefinition {
  // Resolved once, synchronously, at registration time — mirrors the Python factory's
  // `root = Path(workspace).resolve()`. realpath so a symlinked workspace root still
  // anchors the containment check below to the real directory tree.
  let root: string;
  try {
    root = realpathSync(path.resolve(workspace));
  } catch {
    root = path.resolve(workspace);
  }

  return {
    name: "grep",
    schema: GREP_SCHEMA,
    metadata: { category: "search", riskLevel: "low", risk: "read", requiresApproval: false, capabilities: ["search"] },
    execute: async (args, ctx) => {
      try {
        const pattern = typeof args.pattern === "string" ? args.pattern : String(args.pattern ?? "");
        const subPath = typeof args.path === "string" && args.path.length > 0 ? args.path : ".";
        const glob = typeof args.glob === "string" ? args.glob : undefined;
        const n = clampMaxResults(args.max_results);

        const base = await resolveWithinWorkspace(root, subPath);
        if (base === null) return { error: "path escapes the workspace" };

        if (await hasRipgrep()) {
          return await runRipgrep(root, base, pattern, glob, n, ctx.signal);
        }
        return await runPyGrep(root, base, pattern, glob, n, ctx.signal);
      } catch (err) {
        return { error: `grep failed: ${describeError(err)}` };
      }
    },
  };
}

function clampMaxResults(raw: unknown): number {
  const n = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 100;
  return Math.min(n, 1000);
}

/** Resolve `sub` against `root`, following symlinks the way Python's `Path.resolve()` does,
 * and reject anything that lands outside the workspace (mirrors the Python source's
 * `base.relative_to(root)` escape check). A not-yet-existing path falls back to lexical
 * resolution — it can't find files either way, so there's no containment risk in that case. */
async function resolveWithinWorkspace(root: string, sub: string): Promise<string | null> {
  const lexical = path.resolve(root, sub);
  let real: string;
  try {
    real = await realpath(lexical);
  } catch {
    real = lexical;
  }
  const rel = path.relative(root, real);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return real;
}

async function runRipgrep(
  root: string,
  base: string,
  pattern: string,
  glob: string | undefined,
  n: number,
  signal: AbortSignal,
): Promise<unknown> {
  const cmdArgs = ["--line-number", "--no-heading", "--color=never", "--max-count", String(n), "-e", pattern];
  if (glob) cmdArgs.push("--glob", glob);
  // Do not rely solely on the workspace's .gitignore: the fallback walk always omits these
  // generated/dependency dirs too. Exclusions come last — ripgrep resolves conflicting
  // globs with the later one winning.
  for (const dir of [...IGNORE_DIRS].sort()) cmdArgs.push("--glob", `!**/${dir}/**`);
  cmdArgs.push(base);

  try {
    const { stdout } = await execFileAsync("rg", cmdArgs, { timeout: 30_000, maxBuffer: 20 * 1024 * 1024, signal });
    return { engine: "ripgrep", ...parseRipgrepOutput(stdout, root, n) };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
    // execFile sets `.code` to the process's numeric exit code when it ran but failed, but
    // NodeJS.ErrnoException types it as `string` (that field is really only for spawn-level
    // errors like ENOENT) — compare as a string to satisfy both runtime shapes.
    if (String(e.code) === "1") return { engine: "ripgrep", count: 0, matches: [] }; // 1 = no matches
    if (e.killed) return { error: "grep timed out or was cancelled" };
    return { error: (e.stderr || e.message || "ripgrep error").trim().slice(0, 300) };
  }
}

function parseRipgrepOutput(stdout: string, root: string, n: number): { count: number; matches: GrepMatch[] } {
  const matches: GrepMatch[] = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const parts = splitLimit(line, ":", 2);
    if (parts.length === 3) {
      const [f, ln, text] = parts;
      matches.push({ file: relativeToRoot(f, root), line: /^\d+$/.test(ln) ? Number(ln) : 0, text: text.slice(0, 300) });
    }
    if (matches.length >= n) break;
  }
  return { count: matches.length, matches };
}

/** `str.split(sep, maxsplit)` from Python — JS's String.split has no maxsplit equivalent. */
function splitLimit(str: string, sep: string, times: number): string[] {
  const out: string[] = [];
  let rest = str;
  for (let i = 0; i < times; i++) {
    const idx = rest.indexOf(sep);
    if (idx === -1) break;
    out.push(rest.slice(0, idx));
    rest = rest.slice(idx + sep.length);
  }
  out.push(rest);
  return out;
}

function relativeToRoot(p: string, root: string): string {
  try {
    const rel = path.relative(root, path.resolve(p));
    if (rel.startsWith("..") || path.isAbsolute(rel)) return p;
    return rel;
  } catch {
    return p;
  }
}

async function runPyGrep(
  root: string,
  base: string,
  pattern: string,
  glob: string | undefined,
  n: number,
  signal: AbortSignal,
): Promise<unknown> {
  let rx: RegExp;
  try {
    rx = new RegExp(pattern);
  } catch (err) {
    return { error: `invalid regex: ${describeError(err)}`, count: 0, matches: [] };
  }
  const globRx = glob ? globToRegExp(glob) : undefined;
  const matches: GrepMatch[] = [];
  await walk(base, async (filePath) => {
    if (signal.aborted) return true;
    const fn = path.basename(filePath);
    if (globRx && !globRx.test(fn)) return false;
    return await grepOneFile(filePath, root, rx, matches, n);
  });
  return { engine: "python", count: matches.length, matches };
}

/** Recursive directory walk pruning `IGNORE_DIRS`; `onFile` returns true to stop early.
 * Symlinked directories/files are skipped rather than followed — avoids symlink cycles,
 * which is at least as safe as Python's `os.walk(followlinks=False)` default. */
async function walk(dir: string, onFile: (filePath: string) => Promise<boolean>): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      if (await walk(full, onFile)) return true;
    } else if (entry.isFile()) {
      if (await onFile(full)) return true;
    }
  }
  return false;
}

async function grepOneFile(fp: string, root: string, rx: RegExp, matches: GrepMatch[], n: number): Promise<boolean> {
  let content: string;
  try {
    content = (await readFile(fp)).toString("utf8");
  } catch {
    return false; // unreadable (permissions, race with deletion, …) — skip, matches Python's OSError continue
  }
  const lines = content.split(/\r\n|\n|\r/);
  if (lines.length > 0 && lines[lines.length - 1] === "" && /[\r\n]$/.test(content)) {
    lines.pop(); // trailing newline shouldn't produce a phantom final "line"
  }
  const rel = relativeToRoot(fp, root);
  for (let i = 0; i < lines.length; i++) {
    if (rx.test(lines[i])) {
      matches.push({ file: rel, line: i + 1, text: lines[i].slice(0, 300) });
      if (matches.length >= n) return true;
    }
  }
  return false;
}

/** Minimal port of Python's `fnmatch.translate` — enough for the `*`/`?`/`[seq]` filename
 * globs this tool's `glob` argument is documented to accept. */
function globToRegExp(glob: string): RegExp {
  let re = "";
  const n = glob.length;
  let i = 0;
  while (i < n) {
    const c = glob[i++];
    if (c === "*") {
      re += ".*";
    } else if (c === "?") {
      re += ".";
    } else if (c === "[") {
      let j = i;
      if (j < n && glob[j] === "!") j++;
      if (j < n && glob[j] === "]") j++;
      while (j < n && glob[j] !== "]") j++;
      if (j >= n) {
        re += "\\[";
      } else {
        let stuff = glob.slice(i, j).replace(/\\/g, "\\\\");
        i = j + 1;
        if (stuff.startsWith("!")) stuff = "^" + stuff.slice(1);
        else if (stuff.startsWith("^")) stuff = "\\" + stuff;
        re += `[${stuff}]`;
      }
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
