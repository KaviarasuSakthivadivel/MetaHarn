import os from "node:os";
import path from "node:path";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { readFile as readFileAsync, rm as rmAsync } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HANDOFF_PROMPT, type AgentAdapter, type ForkResult, type LaunchOpts, type TerminalSessionStats } from "./types.js";
import { shellQuote } from "./shell-quote.js";

const execFileAsync = promisify(execFile);
const CODEX_SESSIONS_ROOT = path.join(os.homedir(), ".codex", "sessions");

// The rollout-filename pattern and every function below are now directly
// verified against a real Codex 0.148.0 install (findRolloutFile,
// discoverExternalSessionId, and getStats' schema were all confirmed
// against a real transcript). Every function is still written defensively
// regardless — "not found yet" is always a plain null/false return, never a
// thrown error, the same contract claude.ts's hasRecordedSession
// establishes (a session genuinely not existing yet is an expected, common
// state, not something worth engineering out).
const ROLLOUT_FILE_RE = /^rollout-.*-([0-9a-f-]{36})\.jsonl$/;

function findRolloutFile(externalId: string): string | null {
  if (!existsSync(CODEX_SESSIONS_ROOT)) return null;
  // Node 20+ supports the recursive option natively — no new dependency.
  let entries: string[];
  try {
    entries = readdirSync(CODEX_SESSIONS_ROOT, { recursive: true }) as string[];
  } catch {
    return null;
  }
  const match = entries.find((entry) => entry.endsWith(`-${externalId}.jsonl`) && path.basename(entry).startsWith("rollout-"));
  return match ? path.join(CODEX_SESSIONS_ROOT, match) : null;
}

function hasRecordedSession(_cwd: string, externalId: string): boolean {
  return findRolloutFile(externalId) !== null;
}

function buildLaunchCommand({ externalSessionId, seedPrompt }: LaunchOpts): string {
  // Codex has no --session-id-equivalent flag to force a new session's id
  // upfront (confirmed unimplemented as of an open codex feature request,
  // openai/codex#13242) — a fresh session is just `codex`, no id argument
  // possible. Resuming a known one is `codex resume <id>`.
  if (externalSessionId) return `codex resume ${externalSessionId}`;
  // seedPrompt is only ever set right after an agent swap (see
  // agents/handoff.ts) — `codex [PROMPT]` (confirmed via `codex --help`:
  // "Optional user prompt to start the session") starts a fresh session
  // already primed with it as the first turn.
  return seedPrompt ? `codex ${shellQuote(seedPrompt)}` : "codex";
}

/**
 * Best-effort discovery of a just-created Codex session's real id, run
 * because Codex can't be told its id upfront (see buildLaunchCommand).
 * Scans today's date directory for rollout files written since `sinceMs`;
 * the trailing UUID in the filename is presumed to be codex resume's id
 * argument (corroborated pattern, not independently confirmed against a
 * real file). Exactly one fresh candidate -> extract and return its id.
 * Zero or multiple candidates -> null, an expected/retryable state (the
 * file may not be written yet, or two Codex terminals in the same project
 * raced) rather than a guess.
 */
async function discoverExternalSessionId({ sinceMs }: { cwd: string; sinceMs: number }): Promise<string | null> {
  const now = new Date();
  const dateDir = path.join(
    CODEX_SESSIONS_ROOT,
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  );
  if (!existsSync(dateDir)) return null;

  let files: string[];
  try {
    files = readdirSync(dateDir);
  } catch {
    return null;
  }

  const candidates = files
    .map((name) => ({ name, match: name.match(ROLLOUT_FILE_RE) }))
    .filter((f): f is { name: string; match: RegExpMatchArray } => f.match !== null)
    .filter((f) => {
      try {
        return statSync(path.join(dateDir, f.name)).mtimeMs >= sinceMs;
      } catch {
        return false;
      }
    });

  return candidates.length === 1 ? candidates[0].match[1] : null;
}

function forkSession(cwd: string, sourceId: string, newId: string): ForkResult {
  const file = findRolloutFile(sourceId);
  if (!file) return { ok: false, reason: "Nothing recorded for the source session yet." };
  const content = readFileSync(file, "utf-8");
  // Claude's transcript embeds its session id verbatim throughout the
  // file (verified). That's only assumed, not confirmed, for Codex's
  // rollout format — self-check before writing anything rather than
  // trusting an unverified assumption and risking a copy that silently
  // doesn't actually resume.
  if (!content.includes(sourceId)) {
    return { ok: false, reason: "Codex's transcript format didn't match what forking expects." };
  }
  const newContent = content.split(sourceId).join(newId);
  const newPath = file.replace(sourceId, newId);
  writeFileSync(newPath, newContent, "utf-8");
  return { ok: true, externalId: newId };
}

// Verified directly against a real rollout file (Codex 0.148.0) — every
// line is `{timestamp, ordinal, type, payload}`. Token usage lives under
// `type: "event_msg"`, `payload.type: "token_count"`, `payload.info`; chat
// content under `type: "response_item"`, `payload.type: "message"` with a
// `role`; tool activity as `payload.type: "custom_tool_call"` /
// `"custom_tool_call_output"`; the active model under `type: "world_state"`,
// `payload.state.collaboration_mode.model`.
interface CodexTokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}
interface CodexTokenCountInfo {
  total_token_usage?: CodexTokenUsage;
  last_token_usage?: CodexTokenUsage;
  model_context_window?: number;
}
interface CodexEntry {
  type?: string;
  payload?: {
    type?: string;
    role?: string;
    info?: CodexTokenCountInfo;
    state?: { collaboration_mode?: { model?: string } };
  };
}

function getStats(_cwd: string, externalId: string): TerminalSessionStats | null {
  const file = findRolloutFile(externalId);
  if (!file) return null;

  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  let toolResults = 0;
  let model: string | undefined;
  // Every token_count event's `info` is itself already a full snapshot
  // (total_token_usage is a running cumulative counter, last_token_usage is
  // just the most recent turn) — keeping only the last one seen gives the
  // final, most complete numbers, same idea as Claude's "last assistant
  // entry wins" for contextUsage.
  let latestInfo: CodexTokenCountInfo | undefined;

  for (const line of readFileSync(file, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    let entry: CodexEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a partially-written last line (session still active) — skip, not fatal
    }

    const payload = entry.payload;
    if (entry.type === "response_item" && payload?.type === "message") {
      if (payload.role === "user") userMessages++;
      else if (payload.role === "assistant") assistantMessages++;
    }
    if (entry.type === "response_item" && payload?.type === "custom_tool_call") toolCalls++;
    if (entry.type === "response_item" && payload?.type === "custom_tool_call_output") toolResults++;
    if (entry.type === "world_state" && payload?.state?.collaboration_mode?.model) {
      model = payload.state.collaboration_mode.model;
    }
    if (entry.type === "event_msg" && payload?.type === "token_count" && payload.info) {
      latestInfo = payload.info;
    }
  }

  if (!latestInfo) return null;

  const cumulative = latestInfo.total_token_usage;
  const latest = latestInfo.last_token_usage;
  // model_context_window is a real, exact figure straight from the CLI —
  // unlike Claude's adapter, no hardcoded guess table needed here.
  const contextWindow = latestInfo.model_context_window ?? 200_000;

  return {
    sessionFile: file,
    sessionId: externalId,
    model,
    userMessages,
    assistantMessages,
    toolCalls,
    toolResults,
    totalMessages: userMessages + assistantMessages,
    tokens: {
      input: cumulative?.input_tokens ?? 0,
      output: cumulative?.output_tokens ?? 0,
      cacheRead: cumulative?.cached_input_tokens ?? 0,
      cacheWrite: cumulative?.cache_write_input_tokens ?? 0,
      total: cumulative?.total_tokens ?? 0,
    },
    cost: 0,
    contextUsage: latest?.total_tokens
      ? { tokens: latest.total_tokens, contextWindow, percent: (latest.total_tokens / contextWindow) * 100 }
      : undefined,
  };
}

const HANDOFF_TIMEOUT_MS = 45_000;

/**
 * `codex exec resume <id> -o <file> "<prompt>"` — live-tested successfully
 * against a real Codex session on this machine: produced a clean, accurate
 * summary of real prior work in ~10s. `-o/--output-last-message` writes
 * just the agent's final response text to a file, no JSONL/event noise to
 * parse (the alternative, plain stdout, interleaves formatted progress
 * output with the response).
 */
async function summarizeForHandoff(cwd: string, externalId: string): Promise<string | null> {
  const tmpFile = path.join(os.tmpdir(), `metaharn-codex-handoff-${externalId}-${Date.now()}.txt`);
  try {
    await execFileAsync("codex", ["exec", "resume", externalId, "-o", tmpFile, HANDOFF_PROMPT], {
      cwd,
      timeout: HANDOFF_TIMEOUT_MS,
    });
    const summary = (await readFileAsync(tmpFile, "utf-8")).trim();
    return summary || null;
  } finally {
    await rmAsync(tmpFile, { force: true });
  }
}

export const codexAdapter: AgentAdapter = {
  kind: "codex",
  displayName: "Codex",
  binary: "codex",
  canForceSessionId: false,
  // No confirmed self-update subcommand found in Codex's docs — npm is its
  // confirmed official install path, so agents/lifecycle.ts's npm fallback
  // is used for upgrades (no selfUpdateCommand override here).
  npmPackage: "@openai/codex",
  buildLaunchCommand,
  hasRecordedSession,
  discoverExternalSessionId,
  forkSession,
  getStats,
  summarizeForHandoff,
};
