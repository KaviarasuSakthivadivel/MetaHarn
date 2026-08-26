/**
 * What the agent itself created this session — and the one fact that follows (OpenWorker's
 * OPE-114 §1).
 *
 * The reviewer is never shown file contents, so `python scripts/setup.py` cannot be judged
 * from its text: the effect lives inside a file neither the reviewer nor the human at the
 * card is shown. But the engine knows something neither of them does — whether it wrote or
 * downloaded that file moments ago. This module keeps that record and renders it as one line
 * of fixed-vocabulary fact (see `Match.render`).
 *
 * Deliberately NOT here: reading file contents, analysing what a script does, or tracing
 * values out of untrusted text (the general taint tracking OPE-114 gestures at is a separate,
 * larger design). A miss leaves behaviour exactly as it is today, so partial coverage only
 * ever moves toward caution — unlike a detector, whose false negatives would breed false
 * confidence.
 *
 * Deviation from OpenWorker's `coworker/provenance.py`: the Python `SessionFiles.record()`
 * takes `(tool_name, arguments, result)` and resolves the written/downloaded path itself via
 * `permissions.write_paths()` — a table from write-tool name to its path argument
 * (`write_file` -> `path`, etc.) owned by the permission engine. No such table exists yet in
 * this package (no filesystem-write tools or permission engine have landed here — see
 * README's module map), and guessing at argument names for tools this workstream has never
 * seen would be worse than not guessing. So `record()` here takes the resolved path(s)
 * directly: the write tool already knows exactly what it wrote when it succeeds, more
 * reliably than this module could infer it. The shell-specific heuristics
 * (`commandPaths`/`shellDownloadPaths`) ARE ported faithfully, since they're fully
 * self-contained — no external table needed to read a `curl -o out.bin` command.
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join as joinPath, resolve as resolvePathLexical } from "node:path";

export const WRITTEN = "written";
export const DOWNLOADED = "downloaded";
export type OriginKind = typeof WRITTEN | typeof DOWNLOADED;

/** How a path came into being this session, and at which step. */
export interface Origin {
  readonly step: number;
  readonly kind: OriginKind;
}

/** A proposed call naming a path this session created. */
export class Match {
  constructor(
    /** As written in the call, for the human-facing line. */
    readonly path: string,
    readonly origin: Origin,
    readonly stepsAgo: number,
  ) {}

  get downloaded(): boolean {
    return this.origin.kind === DOWNLOADED;
  }

  /** One line, fixed vocabulary — never file content, never outside-authored text. Matches
   * the exact wording OpenWorker's `Match.render` uses (verbs are "created"/"downloaded",
   * never "written" — this file's own `WRITTEN` kind renders as "created"). */
  render(): string {
    const verb = this.downloaded ? "downloaded" : "created";
    const when =
      this.stepsAgo <= 0 ? "just now" : this.stepsAgo === 1 ? "1 step ago" : `${this.stepsAgo} steps ago`;
    return `${this.path} was ${verb} by the agent ${when}`;
  }
}

/** `~` and `~/...` expansion — Node has no `Path.expanduser()` equivalent. */
function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return homedir() + path.slice(1);
  return path;
}

/**
 * One canonical key per file, so `./a.py`, `a.py` and the absolute form collapse. Mirrors
 * the (future) permission engine's scoping resolution: relative paths hang off the workspace
 * root, absolute and `~` forms are taken as-is.
 *
 * Resolves symlinks via `realpathSync` when the path exists (matching Python's
 * `Path.resolve()`, which does the same); falls back to a purely lexical normalization when
 * it doesn't (a file about to be created, or an exotic/unreadable path) — Node's
 * `realpathSync` fails outright on a missing path where Python's non-strict `resolve()`
 * degrades gracefully, so this is a deliberate simplification of that edge, not a functional
 * gap for the common case (matching a call against a path this session already wrote).
 */
export function resolvePath(path: string, root: string): string {
  const expanded = expandHome(String(path));
  const candidate = isAbsolute(expanded) ? expanded : joinPath(root, expanded);
  try {
    return realpathSync(candidate);
  } catch {
    return resolvePathLexical(candidate);
  }
}

// -- shell-command path heuristics (self-contained, no external table needed) -------------

// Extensions that make a bare token (no path separator) worth resolving as a file.
const SCRIPT_SUFFIXES = new Set([
  ".py", ".sh", ".bash", ".zsh", ".js", ".mjs", ".cjs", ".ts", ".rb", ".pl",
  ".php", ".ps1", ".bat", ".cmd", ".jar", ".exe", ".json", ".yml", ".yaml",
  ".ini", ".toml", ".cfg", ".mk",
]);

/** True when a bare token is worth treating as a candidate file path. Semantics-free and
 * conservative on purpose: understanding the command is exactly the thing that cannot be
 * done reliably from its text — see `commandPaths`. */
export function looksLikePath(token: string): boolean {
  if (!token || token.startsWith("-") || token.includes("://")) return false;
  if (token.includes("/") || token.includes("\\")) return true;
  const dot = token.lastIndexOf(".");
  return dot !== -1 && SCRIPT_SUFFIXES.has(token.slice(dot).toLowerCase());
}

function programName(head: string): string {
  const idx = Math.max(head.lastIndexOf("/"), head.lastIndexOf("\\"));
  const name = (idx === -1 ? head : head.slice(idx + 1)).toLowerCase();
  return name.endsWith(".exe") ? name.slice(0, -4) : name;
}

// Separators that chain several commands into one string. Longest first so "&&" isn't read
// as two "&"s, and "|&"/"||" aren't read as a "|" plus a leftover. Splitting is textual and
// deliberately over-eager: more parts to scan can only ever surface more paths, never hide
// one.
const COMPOUND_SEPARATORS = ["&&", "||", "|&", ";", "|", "&", "\n", "\r"];

function splitCompoundCommand(command: string): string[] {
  let parts = [command];
  for (const sep of COMPOUND_SEPARATORS) {
    const next: string[] = [];
    for (const part of parts) next.push(...part.split(sep));
    parts = next;
  }
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/**
 * A loose, quote-aware whitespace tokenizer — not a full `shlex.split` port (no backslash
 * escapes), which is fine here: an unbalanced-quote input falls back to a bare whitespace
 * split, exactly like the Python original falls back to `str.split()` on `shlex.split`
 * raising `ValueError`. Over-splitting only ever produces more candidate tokens to check.
 */
function looseShellSplit(input: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let has = false;
  let quote: '"' | "'" | null = null;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      has = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (has) {
        tokens.push(cur);
        cur = "";
        has = false;
      }
      continue;
    }
    cur += ch;
    has = true;
  }
  if (quote) return input.split(/\s+/).filter(Boolean); // unbalanced quotes: still worth scanning
  if (has) tokens.push(cur);
  return tokens;
}

function subCommands(command: string): string[][] {
  const out: string[][] = [];
  for (const part of splitCompoundCommand(command)) {
    const argv = looseShellSplit(part);
    if (argv.length > 0) out.push(argv);
  }
  return out;
}

// Programs whose real input is a file they never name on the command line. Without this,
// `make deploy` would look like it touches nothing at all.
const IMPLICIT_TARGETS = new Map<string, readonly string[]>([
  ["make", ["Makefile", "makefile", "GNUmakefile"]],
  ["npm", ["package.json"]],
  ["pnpm", ["package.json"]],
  ["yarn", ["package.json"]],
  ["bun", ["package.json"]],
  ["pytest", ["conftest.py"]],
  ["tox", ["tox.ini"]],
  ["nox", ["noxfile.py"]],
  ["docker-compose", ["docker-compose.yml", "docker-compose.yaml", "compose.yaml", "compose.yml"]],
]);

/**
 * Every path a shell command names, plus the implicit files it would read.
 *
 * No attempt is made to work out WHICH token is "the script" — every path-like token is
 * returned and checked. Known misses, by design rather than oversight: a file that only
 * becomes involved through an import or include (agent writes `helper.py`, runs `main.py`)
 * is invisible here, and no cheap analysis would find it.
 */
export function commandPaths(command: string): string[] {
  const found: string[] = [];
  for (const argv of subCommands(command)) {
    for (const tok of argv.slice(1)) if (looksLikePath(tok)) found.push(tok);
    let program = programName(argv[0]);
    if (program === "docker" && argv.length > 1 && argv[1].toLowerCase() === "compose") {
      program = "docker-compose";
    }
    found.push(...(IMPLICIT_TARGETS.get(program) ?? []));
    if (looksLikePath(argv[0])) found.push(argv[0]); // ./run.sh
  }
  return found;
}

// Shell fetchers: program -> flags whose VALUE names an output path. `curl -O` (no value,
// saves under the URL's basename) is handled separately. Case matters for the unix tools —
// curl's `-o FILE` and `-O` are different flags — so only the PowerShell names are folded.
const FETCHER_OUTPUT_FLAGS = new Map<string, ReadonlySet<string>>([
  ["curl", new Set(["-o", "--output"])],
  ["wget", new Set(["-O", "--output-document"])],
  ["invoke-webrequest", new Set(["-outfile"])],
  ["iwr", new Set(["-outfile"])],
]);
const CASE_FOLDED_FETCHERS = new Set(["invoke-webrequest", "iwr"]);

/** Output paths of fetch commands. `curl URL | sh` writes no file and needs no entry: a pipe
 * already costs a command its prefix eligibility elsewhere, so it gates today. */
function shellDownloadPaths(command: string): string[] {
  const out: string[] = [];
  for (const argv of subCommands(command)) {
    const program = programName(argv[0]);
    const flags = FETCHER_OUTPUT_FLAGS.get(program);
    if (!flags) continue;
    const folded = CASE_FOLDED_FETCHERS.has(program);
    for (let i = 1; i < argv.length; i++) {
      const probe = folded ? argv[i].toLowerCase() : argv[i];
      if (flags.has(probe) && i + 1 < argv.length) out.push(argv[i + 1]);
    }
    if (program === "curl" && argv.slice(1).includes("-O")) {
      // curl -O saves under the URL's own basename.
      for (const candidate of argv.slice(1)) {
        if (candidate.includes("://")) {
          const name = candidate.split("?")[0].replace(/\/+$/, "").split("/").pop();
          if (name) out.push(name);
          break;
        }
      }
    }
  }
  return out;
}

/** Paths a PROPOSED call would run or act on. Shell only in phase 1: it's where the
 * write-then-execute chain lands, and where the command text hides the effect. */
export function referencedPaths(
  toolName: string,
  args: Record<string, unknown>,
  shellToolName: string,
): string[] {
  if (toolName !== shellToolName) return [];
  return commandPaths(String((args ?? {})["command"] ?? ""));
}

export interface SessionFilesOptions {
  /** Root relative paths hang off when resolving to a canonical key. */
  workspaceRoot: string;
  /** Name of the shell-execution tool — the only tool whose ARGUMENTS (not just its result)
   * are scanned for paths, since that's where a write-then-execute chain hides its effect.
   * Defaults to `"run_shell"` to match OpenWorker's tool naming; override if this package's
   * shell tool ships under a different name. */
  shellToolName?: string;
}

/**
 * Per-session record of what the agent created. Runtime-only, like the engine's other
 * reviewer-facing state: a restart starts clean rather than inheriting stale provenance.
 */
export class SessionFiles {
  private readonly root: string;
  private readonly shellToolName: string;
  private readonly files = new Map<string, Origin>();

  constructor(opts: SessionFilesOptions) {
    this.root = opts.workspaceRoot;
    this.shellToolName = opts.shellToolName ?? "run_shell";
  }

  /**
   * Note paths a SUCCESSFUL write or download call created, at the given step. Callers must
   * not record failed calls — a write that raised left nothing on disk to run.
   *
   * Unlike OpenWorker's `record(tool_name, arguments, result, step)`, this takes the
   * resolved path(s) directly rather than re-deriving them from a write-tool argument table
   * this package doesn't have yet (see module docstring) — the caller already knows exactly
   * what its own successful call wrote.
   */
  record(paths: Iterable<string>, kind: OriginKind, step: number): void {
    for (const path of paths) {
      // A later write/download over the same path wins — the newer bytes are the ones that
      // would execute.
      this.files.set(resolvePath(path, this.root), { step, kind });
    }
  }

  /** Convenience for the shell tool specifically: scan a command for fetcher output paths
   * (`curl -o`, `wget -O`, `curl -O`, PowerShell `-OutFile`) and record them as downloaded.
   * Fully self-contained — the path comes straight out of the command text, no write-tool
   * table needed. */
  recordShellDownloads(command: string, step: number): void {
    this.record(shellDownloadPaths(command), DOWNLOADED, step);
  }

  /** The most recently created path a PROPOSED call names, or `null`. Newest wins: it's the
   * one whose contents the agent most recently controlled. */
  match(toolName: string, args: Record<string, unknown>, step: number): Match | null {
    let best: Match | null = null;
    for (const path of referencedPaths(toolName, args, this.shellToolName)) {
      const origin = this.files.get(resolvePath(path, this.root));
      if (!origin) continue;
      if (best === null || origin.step > best.origin.step) {
        best = new Match(path, origin, Math.max(step - origin.step, 0));
      }
    }
    return best;
  }
}
