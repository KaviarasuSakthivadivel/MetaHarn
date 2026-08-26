/**
 * Workspace roots — the directories a session is allowed to touch.
 *
 * A session owns a primary root (index 0 — writable by convention, the default save
 * location) and may gain access to additional folders at runtime, each read-only or
 * read-write (see `tools/directories.ts`'s `request_directory`). The same `RootDir[]` is
 * meant to be shared *by reference* across the permission engine (scoping), a file toolkit
 * (path resolution), and the context injector (so the agent is told which dirs it has) —
 * push/splice the array in place and every holder sees the change on its next check.
 *
 * Ported from OpenWorker's coworker/roots.py.
 */
import { homedir } from "node:os";
import path from "node:path";
import { realpathSync } from "node:fs";

export interface RootDir {
  /** Absolute, symlink-resolved (as far as the filesystem allows — see `resolveRealPath`). */
  readonly path: string;
  readonly writable: boolean;
  /** Display name; defaults to the resolved dir's basename. */
  readonly label: string;
}

/** What callers may hand to `normalizeRoots`/`makeRootDir`: an already-built `RootDir`, a
 * loose `{path, writable?, label?}` object (writable/label default false/""), or a bare
 * string/path — treated as read-only, mirroring the Python original ("pass dicts/RootDirs
 * to grant write"). */
export type RootDirInput = RootDir | { path: string; writable?: boolean; label?: string } | string;

/**
 * Expand `~`, resolve relative paths against `base` (default: `process.cwd()`), and resolve
 * symlinks as far as the filesystem allows — mirroring Python's `Path(...).resolve()`
 * (`strict=False`): it must not throw when the final component doesn't exist yet (a write
 * target that hasn't been created), which rules out a plain `fs.realpathSync(full)`. Instead
 * this walks up to the longest existing ancestor, realpaths *that*, and re-appends the
 * non-existent tail literally. This matters for security, not just cosmetics: a malicious
 * symlink inside an otherwise-writable root must resolve to where it actually points before
 * root-containment is checked, or scoping can be walked around.
 */
export function resolveRealPath(input: string, base: string = process.cwd()): string {
  const expanded =
    input === "~" ? homedir() : input.startsWith("~/") || input.startsWith("~\\") ? path.join(homedir(), input.slice(2)) : input;
  let existing = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(base, expanded);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(existing);
      return tail.length ? path.join(real, ...tail.slice().reverse()) : real;
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return path.resolve(expanded); // nothing on the path exists at all
      tail.push(path.basename(existing));
      existing = parent;
    }
  }
}

function toLooseRoot(input: RootDirInput): { path: string; writable: boolean; label: string } {
  if (typeof input === "string") return { path: input, writable: false, label: "" };
  return { path: input.path, writable: Boolean(input.writable), label: input.label ?? "" };
}

/** Build one normalized `RootDir` — path expanded/resolved, label defaulted to the resolved
 * basename (or the full path when the basename is empty, e.g. the filesystem root). */
export function makeRootDir(input: RootDirInput): RootDir {
  const loose = toLooseRoot(input);
  const resolved = resolveRealPath(loose.path);
  const label = loose.label || path.basename(resolved) || resolved;
  return { path: resolved, writable: loose.writable, label };
}

/** Coerce a mixed list (`RootDir | {path,writable,label} | string`) into `RootDir[]`. Bare
 * string entries are read-only; pass an object/`RootDir` to grant write. Re-run this on every
 * permission check rather than caching it — see the module docstring on why the *input* list
 * is meant to be mutated in place at runtime. */
export function normalizeRoots(roots: RootDirInput[] | null | undefined): RootDir[] {
  return (roots ?? []).map(makeRootDir);
}

/** The `<system-context>` body listing the dirs available this turn. Empty when there are no
 * roots. Index 0 is always the primary. */
export function renderContext(roots: RootDir[]): string {
  if (roots.length === 0) return "";
  const lines = ["Available directories (you may use file/shell tools within these):"];
  const hasSideScratch = roots.some((r, i) => i > 0 && r.label === "scratch");
  roots.forEach((r, i) => {
    const access = r.writable ? "read-write" : "read-only";
    let tag = "";
    if (i === 0 && r.label === "scratch") {
      tag = " — primary scratch, the default place to save files";
    } else if (i === 0) {
      tag = " — the session's workspace (relative paths resolve here)";
    } else if (r.label === "scratch") {
      tag =
        " — your scratch directory: temporary files, and artifacts you don't " +
        "want to leave inside the workspace";
    }
    lines.push(`- ${r.path} [${access}]${tag}`);
  });
  lines.push(
    hasSideScratch
      ? "Relative paths resolve against the workspace; pass an absolute path to use " +
          "another directory. Writes are only allowed in read-write directories. Put " +
          "reports, analyses, and other non-repo deliverables in the scratch directory " +
          "(they appear in the user's Artifacts panel) — write into the workspace only " +
          "for changes that belong in it."
      : "Relative paths resolve against the primary directory; pass an absolute path to use " +
          "another directory. Writes are only allowed in read-write directories. If the user " +
          "cares where a deliverable lands, ask; otherwise save it in the primary scratch.",
  );
  return lines.join("\n");
}
