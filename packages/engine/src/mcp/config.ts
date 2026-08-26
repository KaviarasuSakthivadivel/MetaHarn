/**
 * MCP server config — the standard `mcpServers` JSON, layered global + workspace.
 *
 * Paste-compatible with Claude Desktop / Cursor / Codex: the same `{"mcpServers": {...}}`
 * file shape, extended with a few coworker-style optional fields (`enabled`,
 * `include_tools`/`exclude_tools`, `requires_approval`, `auth`) that other tools simply
 * ignore. `${VAR}` refs in command/args/env/url/headers are resolved at load time.
 *
 * Ported from OpenWorker's coworker/mcp/config.py, simplified for this package's smaller
 * scope: no SecretStore/local-`.env` layering here (no secrets tier exists yet in
 * @metaharn/engine) — `${VAR}` resolves against `process.env` only. Path resolution (where
 * the global/workspace files live) is left to the caller instead of a baked-in `state_dir()`
 * — this package isn't wired to Electron/XDG paths yet (see README's "standalone by design"
 * note), so `loadMcpServers` takes both paths explicitly.
 */
import { readFileSync } from "node:fs";

export type MCPTransport = "stdio" | "http";

export interface MCPServerDef {
  name: string;
  transport: MCPTransport;
  command?: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  url?: string;
  headers: Record<string, string>;
  enabled: boolean;
  includeTools?: string[];
  excludeTools?: string[];
  requiresApproval: boolean;
  /** "oauth" → browser OAuth 2.1 + PKCE, HTTP transport only. Out of scope for this package
   * pass (no SecretStore to persist tokens in yet); a def with `auth: "oauth"` still loads,
   * it just has nowhere to read/write tokens until that tier lands. */
  auth?: "oauth";
}

/** Where to read the two layered config files from. This module only merges/parses — the
 * caller owns resolving these paths (state dir, workspace root, …). */
export interface MCPConfigPaths {
  global: string;
  /** Per-workspace override file — read only when `workspaceTrusted` is true. */
  workspace?: string;
}

export interface LoadMcpServersOptions {
  /**
   * Gate matching config.py's: an untrusted workspace's `.../mcp.json` is never read — MCP
   * config is executable provenance (a stdio entry spawns a process on session open), so
   * cloning a repo alone must never be enough to define what runs there. Same consent
   * boundary a workspace-trust tier would use for e.g. allowed shell commands.
   */
  workspaceTrusted?: boolean;
  /** Defaults to `process.env`; overridable (tests, or a caller with its own env layer). */
  env?: NodeJS.ProcessEnv;
}

const HTTP_TYPES = new Set(["http", "https", "sse", "streamable-http", "streamable_http"]);
const VAR_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function readServersFile(path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {}; // missing file / unreadable / invalid JSON — treated as "no servers defined"
  }
  const servers = (parsed as { mcpServers?: unknown } | null)?.mcpServers;
  return servers && typeof servers === "object" ? (servers as Record<string, unknown>) : {};
}

function resolveVars(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === "string") {
    return value.replace(VAR_REF, (whole: string, name: string) => env[name] ?? whole);
  }
  if (Array.isArray(value)) return value.map((v) => resolveVars(v, env));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, resolveVars(v, env)]),
    );
  }
  return value;
}

function stringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
  );
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.map(String) : undefined;
}

function parseServer(name: string, rawValue: unknown, env: NodeJS.ProcessEnv): MCPServerDef {
  const raw = (resolveVars(rawValue, env) ?? {}) as Record<string, unknown>;
  const declaredType = String(raw.type ?? "").toLowerCase();
  const isHttp = HTTP_TYPES.has(declaredType) || typeof raw.url === "string";
  return {
    name,
    transport: isHttp ? "http" : "stdio",
    command: typeof raw.command === "string" ? raw.command : undefined,
    args: stringList(raw.args) ?? [],
    env: stringMap(raw.env),
    cwd: typeof raw.cwd === "string" ? raw.cwd : undefined,
    url: typeof raw.url === "string" ? raw.url : undefined,
    headers: stringMap(raw.headers),
    enabled: raw.enabled === undefined ? true : Boolean(raw.enabled),
    includeTools: stringList(raw.include_tools),
    excludeTools: stringList(raw.exclude_tools),
    requiresApproval: raw.requires_approval === undefined ? true : Boolean(raw.requires_approval),
    auth: typeof raw.auth === "string" && raw.auth.toLowerCase() === "oauth" ? "oauth" : undefined,
  };
}

/**
 * Merge global + (when trusted) workspace `mcpServers` into parsed server defs.
 *
 * **Global wins on name clash** — even a trusted workspace cannot silently redefine a global
 * server by reusing its name (mirrors config.py's `merged.setdefault(name, raw)` with the
 * global file merged first). Servers are returned in first-seen order (global, then
 * workspace); callers filter/order further as needed (e.g. by `enabled`).
 */
export function loadMcpServers(
  paths: MCPConfigPaths,
  options: LoadMcpServersOptions = {},
): MCPServerDef[] {
  const env = options.env ?? process.env;
  const filePaths = [paths.global];
  if (paths.workspace && options.workspaceTrusted) filePaths.push(paths.workspace);

  const merged = new Map<string, unknown>();
  for (const path of filePaths) {
    for (const [name, raw] of Object.entries(readServersFile(path))) {
      if (raw && typeof raw === "object" && !merged.has(name)) merged.set(name, raw);
    }
  }
  return [...merged.entries()].map(([name, raw]) => parseServer(name, raw, env));
}
