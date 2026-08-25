import type { AgentAdapter, LaunchOpts } from "./types.js";
import { shellQuote } from "./shell-quote.js";

/**
 * Deliberately minimal. Gemini CLI's session files live under
 * `~/.gemini/tmp/<project_hash>/chats/`, but `<project_hash>`'s algorithm
 * is genuinely undocumented — not found across official docs or any
 * third-party source checked. Rather than guess a hash function (the kind
 * of guess that fails silently and confusingly the moment it's wrong — see
 * this codebase's own established practice of documenting approximations
 * instead of shipping unverified ones, e.g. claude.ts's
 * MODEL_CONTEXT_WINDOWS comment), session discovery/resume/fork/stats are
 * simply not implemented here in v0.
 *
 * What still works: a Gemini terminal session launches, and — because the
 * pty-persistence fix in pty-ipc.ts applies to every agent uniformly — it
 * stays alive and switchable across tab switches like any other terminal
 * session for the lifetime of the running app. What doesn't: resuming
 * after the tab is closed (or the app restarts) always starts a brand-new
 * `gemini` session; forking always fails with a clear reason; the context
 * panel always shows its existing "No stats yet" empty state. Revisit once
 * Gemini CLI's on-disk format can be verified against a real install.
 */
function buildLaunchCommand({ seedPrompt }: LaunchOpts): string {
  // seedPrompt is only ever set right after an agent swap TO Gemini (see
  // agents/handoff.ts) — Gemini can never be a handoff *source* (no
  // resumable session to summarize, see the file doc comment above), but it
  // can still be a target: a fresh `gemini "<prompt>"` launch. This
  // positional-prompt form is NOT independently verified the way Claude's
  // and Codex's are (Gemini isn't installed on this machine) — if wrong,
  // this just starts a normal fresh session and the seed text goes
  // nowhere, not a crash.
  return seedPrompt ? `gemini ${shellQuote(seedPrompt)}` : "gemini";
}

export const geminiAdapter: AgentAdapter = {
  kind: "gemini",
  displayName: "Gemini",
  binary: "gemini",
  canForceSessionId: false,
  // No self-update subcommand confirmed — npm is Gemini CLI's confirmed
  // official install path, used as the upgrade mechanism (see
  // agents/lifecycle.ts).
  npmPackage: "@google/gemini-cli",
  buildLaunchCommand,
  hasRecordedSession: () => false,
  forkSession: () => ({ ok: false, reason: "Forking isn't supported for Gemini sessions yet." }),
  getStats: () => null,
};
