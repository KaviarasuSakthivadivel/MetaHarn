import os from "node:os";
import path from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HANDOFF_PROMPT, type AgentAdapter, type ForkResult, type LaunchOpts, type TerminalSessionStats } from "./types.js";
import { shellQuote } from "./shell-quote.js";

const execFileAsync = promisify(execFile);

/** Claude Code CLI's own on-disk path for a session, given the cwd it was started in. */
export function sessionFilePath(cwd: string, sessionId: string): string {
  const projectDir = cwd.replace(/\//g, "-");
  return path.join(os.homedir(), ".claude", "projects", projectDir, `${sessionId}.jsonl`);
}

/**
 * Claude Code CLI doesn't persist an interactive session to disk until it's
 * actually had a real exchange (mirrors Pi's own "don't write a session
 * file for a never-used session" behavior elsewhere in this app) — so a
 * terminal session opened and immediately closed without ever being
 * chatted with has genuinely nothing to resume. `claude --resume <id>` on
 * an id with no recorded conversation fails outright ("No conversation
 * found with session ID: ..."), confirmed by reproducing it. Checking for
 * the session file directly, rather than trusting a "this session was
 * opened before" flag from the renderer, means the pty command can't drift
 * out of sync with what the CLI can actually resume.
 */
function hasRecordedSession(cwd: string, sessionId: string): boolean {
  return existsSync(sessionFilePath(cwd, sessionId));
}

/**
 * "Fork a session" — copies the source session's real transcript file to a
 * new one under `newId`, so the new id has genuine history to `--resume`
 * from the moment it's opened, independent of the original from then on.
 * The session id is embedded in nearly every line of the file (confirmed:
 * 249/255 lines in a real transcript), not just a header, so a plain file
 * copy would leave it internally inconsistent with its new filename — the
 * id is always the same literal UUID string wherever it appears, so a
 * global string replace is sufficient (no JSON-aware rewrite needed).
 * Verified end to end: a forked session, opened fresh under the new id,
 * correctly recalled content from the original conversation.
 */
function forkSessionFile(cwd: string, sourceId: string, newId: string): ForkResult {
  const sourcePath = sessionFilePath(cwd, sourceId);
  if (!existsSync(sourcePath)) return { ok: false, reason: "Nothing recorded for the source session yet." };
  const content = readFileSync(sourcePath, "utf-8").split(sourceId).join(newId);
  writeFileSync(sessionFilePath(cwd, newId), content, "utf-8");
  return { ok: true, externalId: newId };
}

function buildLaunchCommand({ cwd, catalogSessionId, externalSessionId, seedPrompt }: LaunchOpts): string {
  // externalSessionId is always catalogSessionId in practice for Claude —
  // canForceSessionId means MetaHarn's own id doubles as Claude's, forced via
  // --session-id below. `claude --continue` turned out not to be reliable
  // for this — it resumes whatever the CLI itself considers most recent
  // *for this cwd*, ambiguous the moment a project has more than one
  // terminal session — --session-id/--resume with an explicit id sidesteps
  // that entirely, deterministic no matter how many other sessions exist.
  const id = externalSessionId ?? catalogSessionId;
  if (hasRecordedSession(cwd, id)) return `claude --resume ${id}`;
  // seedPrompt is only ever set right after an agent swap (see
  // agents/handoff.ts) — a brand-new session that should open already
  // primed with a summary of the conversation it's replacing, rather than
  // a blank prompt. `claude [options] [prompt]` starts interactively with
  // the prompt as the first turn (confirmed via `claude --help`'s usage
  // line — not live end-to-end tested with --session-id combined).
  return seedPrompt ? `claude --session-id ${id} ${shellQuote(seedPrompt)}` : `claude --session-id ${id}`;
}

// Not from any API — Claude Code CLI exposes no live stats endpoint, so
// this is a reasonable approximation, not an authoritative source. The
// claude-sonnet-5 figure is directly evidenced (matches what a real
// external reference panel displays for the same model); the rest are
// best-guess defaults, called out here so a future reader doesn't mistake
// this table for something Anthropic publishes.
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "claude-sonnet-5": 1_000_000,
  "claude-opus-5": 1_000_000,
  "claude-haiku-4-5": 200_000,
};
const DEFAULT_CONTEXT_WINDOW = 200_000;

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}
interface ContentBlock {
  type?: string;
}
interface TranscriptEntry {
  type?: string;
  timestamp?: string;
  message?: { model?: string; content?: ContentBlock[]; usage?: Usage };
}

/**
 * Computed by reading the real Claude Code CLI transcript file directly —
 * there's no live API to ask the CLI subprocess for this; the file is the
 * only source of truth available. Every assistant message in a real
 * transcript carries a `usage` block (confirmed: 97/97 in one 255-line
 * session) with exactly the fields needed here.
 */
function getStats(cwd: string, externalId: string): TerminalSessionStats | null {
  const filePath = sessionFilePath(cwd, externalId);
  if (!existsSync(filePath)) return null;

  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  let toolResults = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let model: string | undefined;
  let lastUsage: Usage | undefined;

  for (const line of readFileSync(filePath, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a partially-written last line (session still active) — skip, not fatal
    }

    if (entry.type === "user") userMessages++;
    if (entry.type === "assistant") assistantMessages++;

    for (const block of entry.message?.content ?? []) {
      if (block.type === "tool_use") toolCalls++;
      if (block.type === "tool_result") toolResults++;
    }

    const usage = entry.message?.usage;
    if (entry.type === "assistant" && usage) {
      model = entry.message?.model ?? model;
      input += usage.input_tokens ?? 0;
      output += usage.output_tokens ?? 0;
      cacheRead += usage.cache_read_input_tokens ?? 0;
      cacheWrite += usage.cache_creation_input_tokens ?? 0;
      lastUsage = usage;
    }
  }

  const contextWindow = model ? (MODEL_CONTEXT_WINDOWS[model] ?? DEFAULT_CONTEXT_WINDOW) : DEFAULT_CONTEXT_WINDOW;
  // The *latest* turn's context payload — prompt-side tokens only (what was
  // actually sent as context for that call), not its output. Mirrors Pi's
  // own ContextUsage.tokens semantic for chat sessions.
  const latestContextTokens = lastUsage
    ? (lastUsage.input_tokens ?? 0) + (lastUsage.cache_read_input_tokens ?? 0) + (lastUsage.cache_creation_input_tokens ?? 0)
    : null;

  return {
    sessionFile: filePath,
    sessionId: externalId,
    model,
    userMessages,
    assistantMessages,
    toolCalls,
    toolResults,
    totalMessages: userMessages + assistantMessages,
    tokens: { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite },
    // Real per-token pricing isn't available here — showing a made-up
    // dollar figure would be worse than showing nothing. ContextWindowPanel
    // never actually renders this field today, so it's unused, not wrong.
    cost: 0,
    contextUsage:
      latestContextTokens !== null
        ? { tokens: latestContextTokens, contextWindow, percent: (latestContextTokens / contextWindow) * 100 }
        : undefined,
  };
}

// Bounded well above the ~10s a real Codex equivalent took in testing —
// generous, but a hung summarization must never hang the swap itself.
const HANDOFF_TIMEOUT_MS = 45_000;

/**
 * `claude -p --resume <id> "<prompt>"` — Claude's own non-interactive
 * one-shot mode, resumed against a real session. Confirmed via `claude
 * --help`'s documented flags (-p/--print, -r/--resume, positional
 * [prompt]) against a real install; not live end-to-end tested with this
 * exact flag combination (the only resumable session on hand was mid-use
 * in a live pty when this was built, and writing to its transcript
 * concurrently felt too risky to test against).
 */
async function summarizeForHandoff(cwd: string, externalId: string): Promise<string | null> {
  const { stdout } = await execFileAsync("claude", ["-p", "--resume", externalId, HANDOFF_PROMPT], {
    cwd,
    timeout: HANDOFF_TIMEOUT_MS,
  });
  const summary = stdout.trim();
  return summary || null;
}

export const claudeAdapter: AgentAdapter = {
  kind: "claude",
  displayName: "Claude Code",
  binary: "claude",
  canForceSessionId: true,
  npmPackage: "@anthropic-ai/claude-code",
  // Claude Code has its own self-update subcommand ("claude update|upgrade
  // — check for updates and install if available", confirmed via `claude
  // update --help` against a real install) that works regardless of
  // whether the binary came from npm or the current native curl installer
  // (Anthropic deprecated the npm install path in favor of the native
  // installer as of v2.1.15, Jan 2026) — safer than assuming npm here.
  selfUpdateCommand: ["update"],
  buildLaunchCommand,
  hasRecordedSession,
  summarizeForHandoff,
  forkSession: forkSessionFile,
  getStats,
};
