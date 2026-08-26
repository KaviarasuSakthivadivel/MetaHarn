/**
 * Secret store — one canonical, file-backed store for connector/MCP credentials.
 *
 * Design (from OpenWorker, itself from OpenClaw): secrets **never enter the model's context,
 * prompts, or traces**. The store holds profiles keyed by `service[:account]` (an opaque
 * string the caller composes — see `profileKey`); values may be literals OR `${ENV_VAR}`
 * references resolved at READ time from `process.env` / a local `.env` file beside the store.
 *
 * v1 is a `0600` JSON file behind this interface; the interface is what callers depend on, so
 * a Keychain / age-encrypted backend can swap in later without touching them.
 *
 * Ported from OpenWorker's `coworker/secrets.py`. Deviations:
 *   - No baked-in `state_dir()` default path. This package isn't wired to Electron/XDG paths
 *     yet (same call `mcp/config.ts` already makes for the same reason), so `path` is a
 *     required constructor argument — the caller decides where state lives.
 *   - Atomic writes use `fs.openSync(path, "wx", 0o600)` (O_CREAT|O_EXCL) with a
 *     randomly-suffixed temp name instead of `tempfile.mkstemp`, for the same reason the
 *     Python original moved off a fixed `<name>.tmp`: a predictable name is pre-creatable as
 *     a symlink by a local attacker, redirecting the write. `wx` refuses to open through any
 *     existing path — symlink included — so this closes the same hole `mkstemp` does.
 *   - No thread lock: every fs call here is synchronous, and Node is single-threaded, so
 *     there's no interleaving between a read and a write the way Python's `threading.Lock()`
 *     guards against across OS threads.
 *   - Windows ACL restriction is NOT implemented — see `restrictToUserPosix`'s docstring and
 *     the final report. `chmod` cannot express user-only access on Windows, and this module
 *     deliberately does not shell out to `icacls` (the Python original does, behind a
 *     best-effort try/catch); a secret written from this module on Windows keeps whatever
 *     ACLs the containing directory already grants.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join as joinPath } from "node:path";

const IS_WINDOWS = process.platform === "win32";
const REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Compose the `service[:account]` key `get`/`put`/`delete` are keyed by. */
export function profileKey(service: string, account?: string): string {
  return account ? `${service}:${account}` : service;
}

// -- private-file writes -----------------------------------------------------------------

/** Best-effort user-only restriction. POSIX expresses this with mode bits; Windows has none
 * reachable from Node (`chmod` there only toggles the read-only flag), so this is a no-op on
 * Windows by design rather than a silent lie — see module docstring. */
function restrictToUserPosix(path: string, mode: number): void {
  if (IS_WINDOWS) return;
  try {
    chmodSync(path, mode);
  } catch {
    // best-effort — a failed chmod must not block the write it's protecting
  }
}

/**
 * Atomically write `content` to `target`, never exposing it through a readable temp file.
 *
 * `openSync(tmp, "wx", 0o600)` creates with `O_CREAT|O_EXCL` at mode 0600 in one syscall — no
 * window where the plaintext sits at the process umask default, and no chance of following a
 * pre-existing path (including a symlink planted at a predictable name). Collisions retry
 * with a fresh random suffix.
 */
function atomicPrivateWrite(target: string, content: string): void {
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });
  restrictToUserPosix(dir, 0o700);

  const base = target.split(/[\\/]/).pop() ?? "secret";
  let tmp = "";
  let fd = -1;
  for (let attempt = 0; attempt < 5; attempt++) {
    tmp = joinPath(dir, `.${base}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      fd = openSync(tmp, "wx", 0o600);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || attempt === 4) throw err;
    }
  }
  try {
    writeSync(fd, content, null, "utf8");
    closeSync(fd);
    fd = -1;
    restrictToUserPosix(tmp, 0o600); // belt-and-braces alongside the mode passed to openSync
    renameSync(tmp, target);
  } catch (err) {
    if (fd !== -1) {
      try {
        closeSync(fd);
      } catch {
        // best-effort
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort cleanup
    }
    throw err;
  }
}

/** Atomically write a user-only text file using the SecretStore's OS protections. Exported
 * for sibling modules that need the same guarantee for a non-JSON file. */
export function writePrivateText(path: string, content: string): void {
  atomicPrivateWrite(path, content);
}

// -- `${VAR}` resolution ------------------------------------------------------------------

function loadDotenv(path: string): Record<string, string> {
  const env: Record<string, string> = {};
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return env;
  }
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const idx = line.indexOf("=");
    const key = line.slice(0, idx).trim();
    // Mirrors Python's `.strip('"').strip("'")`: strips a run of one quote kind, then a run
    // of the other — not just a single matching pair.
    const value = line
      .slice(idx + 1)
      .trim()
      .replace(/^"+|"+$/g, "")
      .replace(/^'+|'+$/g, "");
    if (key) env[key] = value;
  }
  return env;
}

function resolveRefs(value: unknown, env: Record<string, string>): unknown {
  if (typeof value === "string") {
    return value.replace(REF, (whole, name: string) => process.env[name] ?? env[name] ?? whole);
  }
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, env));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = resolveRefs(v, env);
    return out;
  }
  return value;
}

// -- store --------------------------------------------------------------------------------

export interface SecretStatusEntry {
  profile: string;
  type?: string;
  account?: string;
  /** True when the profile's `expires` field (epoch seconds, like everywhere else this
   * package deals in Unix time) is in the past. */
  expired: boolean;
}

/** File-backed secret store. Reads resolve `${VAR}` refs; `status()` never leaks values. */
export class SecretStore {
  readonly path: string;
  private readonly dotenvPath: string;

  constructor(path: string) {
    this.path = path;
    this.dotenvPath = joinPath(dirname(path), ".env");
  }

  // -- reads --------------------------------------------------------------------------

  /** Return a profile with `${VAR}` refs resolved, or `undefined` if absent. */
  get(profile: string): Record<string, unknown> | undefined {
    const data = this.readAll()[profile];
    if (data === undefined) return undefined;
    return this.resolve(data) as Record<string, unknown>;
  }

  /** Resolve `${VAR}` refs in a value (recursively) from `process.env` + the local `.env`. */
  resolve(value: unknown): unknown {
    return resolveRefs(value, loadDotenv(this.dotenvPath));
  }

  /** Profile metadata only — **never** the secret values themselves. */
  status(): SecretStatusEntry[] {
    const nowSeconds = Date.now() / 1000;
    const out: SecretStatusEntry[] = [];
    for (const [profile, raw] of Object.entries(this.readAll())) {
      const data = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      const expires = data["expires"];
      const expired = typeof expires === "number" && expires < nowSeconds;
      out.push({
        profile,
        type: typeof data["type"] === "string" ? (data["type"] as string) : undefined,
        account: typeof data["accountId"] === "string" ? (data["accountId"] as string) : undefined,
        expired,
      });
    }
    return out;
  }

  // -- writes -------------------------------------------------------------------------

  put(profile: string, data: Record<string, unknown>): void {
    const store = this.readAll();
    store[profile] = data;
    this.writeAll(store);
  }

  delete(profile: string): boolean {
    const store = this.readAll();
    if (!(profile in store)) return false;
    delete store[profile];
    this.writeAll(store);
    return true;
  }

  // -- internals ----------------------------------------------------------------------

  private readAll(): Record<string, unknown> {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return {};
    }
    try {
      const data: unknown = JSON.parse(raw);
      return data !== null && typeof data === "object" ? (data as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  private writeAll(store: Record<string, unknown>): void {
    atomicPrivateWrite(this.path, JSON.stringify(store, null, 2));
  }
}
