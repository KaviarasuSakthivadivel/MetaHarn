import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { AGENT_ADAPTERS, getAdapter, invalidateInstalledCache } from "./registry.js";
import type { AgentKind } from "./types.js";

const execFileAsync = promisify(execFile);

// npm global installs/uninstalls can genuinely take a while (network,
// dependency resolution) — bounded so a stalled command surfaces as a
// clear failure in the UI rather than hanging the IPC call indefinitely.
const COMMAND_TIMEOUT_MS = 120_000;

export interface AgentStatus {
  kind: AgentKind;
  displayName: string;
  installed: boolean;
  version: string | null;
  /** null when the npm registry lookup fails (offline, registry down) —
   * distinct from "no update available", so the UI can say "couldn't
   * check" rather than falsely implying you're up to date. */
  latestVersion: string | null;
  updateAvailable: boolean;
}

export interface CommandResult {
  ok: boolean;
  output: string;
}

function parseVersion(rawOutput: string): string | null {
  // CLI --version output varies in surrounding text (Claude prints
  // "2.1.236 (Claude Code)"; Codex/Gemini's exact format isn't verified
  // against a real install — this regex is robust to prefix/suffix text
  // either way, extracting the first semver-shaped token.
  const match = rawOutput.match(/\d+\.\d+\.\d+/);
  return match ? match[0] : null;
}

function getInstalledVersion(binary: string): string | null {
  try {
    const output = execFileSync(binary, ["--version"], { encoding: "utf-8", timeout: 10_000 });
    return parseVersion(output);
  } catch {
    return null; // not installed, or --version failed — either way, "no version to show"
  }
}

// Short-lived cache — avoids hitting the npm registry on every Settings
// page render/reopen, while still picking up a new release within a
// session. Not persisted; resets on app restart.
const latestVersionCache = new Map<string, { version: string | null; fetchedAt: number }>();
const LATEST_VERSION_CACHE_MS = 5 * 60 * 1000;

async function getLatestVersion(npmPackage: string): Promise<string | null> {
  const cached = latestVersionCache.get(npmPackage);
  if (cached && Date.now() - cached.fetchedAt < LATEST_VERSION_CACHE_MS) return cached.version;

  let version: string | null = null;
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(npmPackage)}/latest`);
    if (res.ok) {
      const data = (await res.json()) as { version?: string };
      version = data.version ?? null;
    }
  } catch {
    version = null; // offline, DNS failure, registry down — "couldn't check," not an error surfaced to the user as fatal
  }
  latestVersionCache.set(npmPackage, { version, fetchedAt: Date.now() });
  return version;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export async function getAgentStatus(kind: AgentKind): Promise<AgentStatus> {
  const adapter = getAdapter(kind);
  const version = getInstalledVersion(adapter.binary);
  const latestVersion = await getLatestVersion(adapter.npmPackage);
  return {
    kind,
    displayName: adapter.displayName,
    installed: version !== null,
    version,
    latestVersion,
    updateAvailable: version !== null && latestVersion !== null && compareVersions(latestVersion, version) > 0,
  };
}

export async function getAllAgentStatuses(): Promise<AgentStatus[]> {
  return Promise.all((Object.keys(AGENT_ADAPTERS) as AgentKind[]).map(getAgentStatus));
}

async function runNpm(args: string[]): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync("npm", args, { timeout: COMMAND_TIMEOUT_MS });
    return { ok: true, output: (stdout + stderr).trim() };
  } catch (err) {
    const error = err as { stdout?: string; stderr?: string; message: string };
    return { ok: false, output: (error.stdout ?? "") + (error.stderr ?? "") || error.message };
  }
}

export async function installAgent(kind: AgentKind): Promise<CommandResult> {
  const adapter = getAdapter(kind);
  const result = await runNpm(["install", "-g", `${adapter.npmPackage}@latest`]);
  invalidateInstalledCache();
  latestVersionCache.delete(adapter.npmPackage);
  return result;
}

export async function uninstallAgent(kind: AgentKind): Promise<CommandResult> {
  const adapter = getAdapter(kind);
  const result = await runNpm(["uninstall", "-g", adapter.npmPackage]);
  invalidateInstalledCache();
  return result;
}

export async function upgradeAgent(kind: AgentKind): Promise<CommandResult> {
  const adapter = getAdapter(kind);
  let result: CommandResult;
  if (adapter.selfUpdateCommand) {
    try {
      const { stdout, stderr } = await execFileAsync(adapter.binary, adapter.selfUpdateCommand, {
        timeout: COMMAND_TIMEOUT_MS,
      });
      result = { ok: true, output: (stdout + stderr).trim() };
    } catch (err) {
      const error = err as { stdout?: string; stderr?: string; message: string };
      result = { ok: false, output: (error.stdout ?? "") + (error.stderr ?? "") || error.message };
    }
  } else {
    result = await runNpm(["install", "-g", `${adapter.npmPackage}@latest`]);
  }
  latestVersionCache.delete(adapter.npmPackage);
  return result;
}
