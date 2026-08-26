/**
 * User-owned trust decisions for repository-provided command allowances.
 *
 * A repository may one day declare command prefixes in its own config, but those grants take
 * effect only after the user trusts that exact canonicalized workspace root. Trust follows
 * the path rather than a snapshot of any config: future changes at a trusted path are
 * accepted until the user revokes trust.
 *
 * Ported from OpenWorker's `coworker/workspace_trust.py`. Deviation: the Python
 * `WorkspaceTrustStore` defaults its path to `state_dir() / "workspace_trust.json"`, a
 * baked-in XDG/`%APPDATA%` lookup. This package isn't wired to Electron/XDG paths yet (see
 * `mcp/config.ts`'s docstring for the same call made there), so `path` is a required
 * constructor argument instead — the caller decides where state lives.
 */
import { chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve as resolvePathLexical } from "node:path";

const IS_WINDOWS = process.platform === "win32";

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return homedir() + path.slice(1);
  return path;
}

interface TrustFile {
  trustedWorkspaces: string[];
}

function isTrustFile(value: unknown): value is TrustFile {
  if (value === null || typeof value !== "object") return false;
  const values = (value as Record<string, unknown>)["trustedWorkspaces"];
  return Array.isArray(values);
}

export class WorkspaceTrustStore {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  /** Canonicalize a workspace path the same way for every caller: `~` expanded, symlinks
   * resolved when the path exists, made absolute either way. This is the join key trust is
   * keyed on, so two spellings of the same directory must always collapse to one entry. */
  static canonical(path: string): string {
    const expanded = expandHome(String(path));
    const absolute = isAbsolute(expanded) ? expanded : resolvePathLexical(expanded);
    try {
      return realpathSync(absolute);
    } catch {
      return resolvePathLexical(absolute);
    }
  }

  private load(): Set<string> {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return new Set();
    }
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return new Set();
    }
    if (!isTrustFile(data)) return new Set();
    return new Set(data.trustedWorkspaces.filter((v): v is string => typeof v === "string" && v.length > 0));
  }

  isTrusted(workspace: string): boolean {
    return this.load().has(WorkspaceTrustStore.canonical(workspace));
  }

  list(): string[] {
    return [...this.load()].sort();
  }

  /** Record (or revoke) trust for a workspace root; returns the canonical path it was stored
   * under. Written atomically: content lands in a uniquely-named temp file (never a
   * predictable `<name>.tmp` a local attacker could pre-create as a symlink), chmod'd to
   * user-only before the rename makes it visible under the real name. */
  setTrusted(workspace: string, trusted: boolean): string {
    const canonical = WorkspaceTrustStore.canonical(workspace);
    const values = this.load();
    if (trusted) values.add(canonical);
    else values.delete(canonical);

    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true });
    const content = JSON.stringify({ trustedWorkspaces: [...values].sort() }, null, 2) + "\n";
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600 });
      // Belt-and-braces: `mode` at creation is already masked to 0600 on POSIX, but chmod
      // explicitly too so intent survives an unusual umask. No-op-ish on Windows (chmod there
      // only toggles the read-only bit); a real ACL restriction needs `icacls`, which this
      // module deliberately does not shell out to — see module docstring / final report.
      if (!IS_WINDOWS) chmodSync(tmp, 0o600);
      renameSync(tmp, this.path);
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        // best-effort cleanup
      }
      throw err;
    }
    return canonical;
  }
}
