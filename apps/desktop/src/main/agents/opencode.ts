import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import type { AgentAdapter, ForkResult, LaunchOpts, TerminalSessionStats } from "./types.js";
import { shellQuote } from "./shell-quote.js";

// Every claim below was checked against a real installed OpenCode (v1.18.13,
// `opencode-ai` on npm — confirmed via `npm view opencode-ai version`), not
// inferred from its docs/README alone (see codex.ts's own doc comment for
// why that distinction matters here: its first-pass transcript-format
// assumptions were wrong until checked against a real file).
//
// OpenCode stores sessions in an internal database, not flat per-session
// files like Claude/Codex/Gemini — there's no on-disk path to `stat()` the
// way `codex.ts`'s findRolloutFile does, so every function here shells out
// to the CLI's own `session`/`export` subcommands instead. Slower than a
// file check, but it's the only real interface OpenCode exposes for this.

interface OpencodeSessionListEntry {
  id: string;
  title?: string;
  created: number;
  updated: number;
  directory?: string;
}

/** `opencode session list --format json` — confirmed real shape via a live
 * test session: `[{id, title, updated, created, projectId, directory}]`.
 * Never throws: any failure (not installed, no sessions yet, unexpected
 * output) is treated the same as "nothing found," matching every other
 * adapter's hasRecordedSession contract. */
function listSessions(cwd: string): OpencodeSessionListEntry[] {
  try {
    const output = execFileSync("opencode", ["session", "list", "--format", "json"], { cwd, encoding: "utf-8" });
    const parsed = JSON.parse(output);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function hasRecordedSession(cwd: string, externalId: string): boolean {
  return listSessions(cwd).some((s) => s.id === externalId);
}

function buildLaunchCommand({ externalSessionId, seedPrompt }: LaunchOpts): string {
  // OpenCode generates its own session ids (confirmed: real ids look like
  // `ses_fda531403ffecDAvuo2loh86Hy`, no flag exists to force a NEW
  // session's id upfront) — same shape as Codex/Gemini, not Claude.
  // `-s/--session <id>` (confirmed via --help, a top-level flag on the
  // default interactive command, same flag `run` uses — verified live only
  // through `run`'s non-interactive path, not independently re-tested in a
  // real interactive TTY, but it's the identical flag at the same level)
  // resumes an existing session.
  if (externalSessionId) return `opencode --session ${externalSessionId}`;
  // seedPrompt is only ever set right after an agent swap (see
  // agents/handoff.ts). `--prompt <text>` is documented by `opencode --help`
  // as "prompt to use" on the default interactive command — inferred to
  // seed the first turn the same way Claude's positional prompt arg does,
  // based on that description; not independently confirmed in a live
  // interactive session (untestable headlessly the way `run`'s non-
  // interactive path was for the resume case above).
  return seedPrompt ? `opencode --prompt ${shellQuote(seedPrompt)}` : "opencode";
}

/**
 * Best-effort discovery of a just-created session's real id (OpenCode can't
 * be told its id upfront — see buildLaunchCommand). Filters
 * `session list`'s real `directory`/`created` fields rather than a
 * filename-pattern/mtime heuristic the way codex.ts has to — a real
 * structural advantage of OpenCode exposing this as structured data.
 * Exactly one fresh candidate for this cwd -> return it; zero or multiple
 * -> null, an expected/retryable state (not yet written, or two OpenCode
 * terminals in the same project raced), same contract every adapter uses.
 */
/** Real bug found and fixed during verification: OpenCode records a
 * session's `directory` as the symlink-resolved real path (confirmed live
 * on macOS — a `/tmp/...` cwd came back as `/private/tmp/...`), so a plain
 * string `===` against the raw `cwd` silently never matched. Resolving
 * both sides through the same realpath call before comparing fixes it;
 * falls back to the raw string on a resolve failure (a cwd that's since
 * been removed, etc.) rather than throwing. */
function normalizePath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

async function discoverExternalSessionId({ cwd, sinceMs }: { cwd: string; sinceMs: number }): Promise<string | null> {
  const realCwd = normalizePath(cwd);
  const candidates = listSessions(cwd).filter(
    (s) => s.directory !== undefined && normalizePath(s.directory) === realCwd && s.created >= sinceMs,
  );
  return candidates.length === 1 ? candidates[0].id : null;
}

const FORK_MESSAGE = "(continuing this session)";

/**
 * A REAL fork, not a declined/simulated one — `opencode run --session <id>
 * --fork "<message>"` genuinely creates an independent new session
 * (confirmed live: forking produced a distinct id, `... (fork #1)` title,
 * listed separately in `session list`, with the source session completely
 * untouched). Unlike Claude/Codex's exact byte-for-byte transcript copy,
 * this is a real, honest limitation worth stating plainly: OpenCode's CLI
 * has no way to fork without sending a real message (`opencode run` with an
 * empty message is rejected outright — confirmed: "Error: You must provide
 * a message or a command"), so the fork ends up with one extra trivial
 * exchange appended versus the source at the moment of forking. Judged a
 * better tradeoff than declining a capability that genuinely, mostly works.
 */
function forkSession(cwd: string, sourceExternalId: string): ForkResult {
  let output: string;
  try {
    output = execFileSync(
      "opencode",
      ["run", "--session", sourceExternalId, "--fork", "--format", "json", FORK_MESSAGE],
      { cwd, encoding: "utf-8" },
    );
  } catch (err) {
    return { ok: false, reason: `opencode fork failed: ${(err as Error).message}` };
  }
  // Every streamed event line carries its own "sessionID" field (confirmed
  // live) — the FIRST one seen is the new fork's id, since OpenCode assigns
  // it before emitting anything else.
  const match = output.match(/"sessionID":"(ses_[a-zA-Z0-9]+)"/);
  if (!match) return { ok: false, reason: "Couldn't parse the forked session's id from opencode's output." };
  return { ok: true, externalId: match[1] };
}

// Shape confirmed live via `opencode export <id>` against a real session —
// NOT inferred from docs. `messages[].info.role` is definitely "user" |
// "assistant" (verified). Tool-call/tool-result part types were NOT
// observed in the trivial test prompt used to verify this shape (it never
// invoked a tool) — toolCalls/toolResults below are therefore a reasonable
// but UNVERIFIED inference from common part-type naming, not a confirmed
// fact the way codex.ts's equivalent counts are. Flagged here rather than
// presented with false confidence.
interface OpencodeExportPart {
  type?: string;
}
interface OpencodeExportMessage {
  info?: { role?: string };
  parts?: OpencodeExportPart[];
}
interface OpencodeExportData {
  info?: {
    id?: string;
    cost?: number;
    model?: { id?: string; providerID?: string };
    tokens?: { input?: number; output?: number; cache?: { read?: number; write?: number } };
  };
  messages?: OpencodeExportMessage[];
}

function getStats(cwd: string, externalId: string): TerminalSessionStats | null {
  let output: string;
  try {
    output = execFileSync("opencode", ["export", externalId], { cwd, encoding: "utf-8" });
  } catch {
    return null;
  }
  // `opencode export` prints a real, human-facing "Exporting session: ..."
  // line before the JSON body (confirmed live) — strip it rather than
  // assuming the whole output is parseable JSON.
  const jsonStart = output.indexOf("{");
  if (jsonStart === -1) return null;
  let data: OpencodeExportData;
  try {
    data = JSON.parse(output.slice(jsonStart));
  } catch {
    return null;
  }
  if (!data.info) return null;

  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  let toolResults = 0;
  for (const message of data.messages ?? []) {
    if (message.info?.role === "user") userMessages++;
    else if (message.info?.role === "assistant") assistantMessages++;
    for (const part of message.parts ?? []) {
      // Unverified inference — see the interface doc comment above.
      if (part.type === "tool" || part.type === "tool-call" || part.type === "tool_use") toolCalls++;
      if (part.type === "tool-result" || part.type === "tool_result") toolResults++;
    }
  }

  const tokens = data.info.tokens;
  const input = tokens?.input ?? 0;
  const output_ = tokens?.output ?? 0;
  const cacheRead = tokens?.cache?.read ?? 0;
  const cacheWrite = tokens?.cache?.write ?? 0;

  return {
    sessionFile: undefined, // no flat file — a real db-backed session, see the file-level doc comment
    sessionId: externalId,
    model: data.info.model ? `${data.info.model.providerID ?? "opencode"}/${data.info.model.id ?? "unknown"}` : undefined,
    userMessages,
    assistantMessages,
    toolCalls,
    toolResults,
    totalMessages: userMessages + assistantMessages,
    tokens: {
      input,
      output: output_,
      cacheRead,
      cacheWrite,
      total: input + output_ + cacheRead + cacheWrite,
    },
    cost: data.info.cost ?? 0,
    // No context-window-size field observed anywhere in a real export —
    // left undefined rather than guessing a number, same "missing means
    // nothing to report" contract this app uses everywhere else.
    contextUsage: undefined,
  };
}

export const opencodeAdapter: AgentAdapter = {
  kind: "opencode",
  displayName: "OpenCode",
  binary: "opencode",
  canForceSessionId: false,
  npmPackage: "opencode-ai",
  // `opencode upgrade` is a real, confirmed subcommand (opencode --help),
  // and self-manages regardless of install method (curl/npm/brew/etc. — see
  // `opencode upgrade --help`'s --method choices) — safer than the npm
  // fallback the same way Claude's own selfUpdateCommand already is.
  selfUpdateCommand: ["upgrade"],
  buildLaunchCommand,
  hasRecordedSession,
  discoverExternalSessionId,
  forkSession,
  getStats,
  // No real, clean non-interactive way to ask OpenCode to summarize its own
  // session was found during research — `opencode run --session <id>
  // "<prompt>"` genuinely resumes and answers (confirmed live), so a
  // handoff summary IS technically obtainable this way, but doing so adds
  // a real extra turn to the session's own history (same constraint
  // forkSession above has to live with), which is a materially worse
  // side effect for a handoff summary than for a fork — a fork is already
  // a new, disposable branch; contaminating the SOURCE session's real
  // history just to summarize it isn't an acceptable tradeoff. Left
  // undefined, same as gemini.ts's honest lack of this capability.
};
