export type AgentKind = "claude" | "codex" | "gemini" | "opencode";

// Lives here (a leaf module every adapter already imports), not in
// handoff.ts, specifically to avoid a circular import: handoff.ts imports
// registry.ts, which imports every concrete adapter (claude.ts etc.) to
// build AGENT_ADAPTERS — an adapter importing back from handoff.ts would
// cycle. Adapters that implement summarizeForHandoff import this constant
// directly; agents/handoff.ts re-exports it for orchestration-side callers.
export const HANDOFF_PROMPT =
  "Summarize what we've discussed and done in this conversation so far, in 3-5 sentences, " +
  "for a handoff to a different AI coding assistant that will continue the work. " +
  "Cover: what we've been working on, key decisions, current state, and next steps.";

/** Same shape preload.ts's SessionStats/ContextUsage expects — kept
 * decoupled from preload's renderer-facing types on purpose, same
 * convention as sessions.ts's treeToDTO. */
export interface TerminalSessionStats {
  sessionFile: string | undefined;
  sessionId: string;
  model?: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
}

export interface LaunchOpts {
  cwd: string;
  /** MetaHarn's own catalog row id for this terminal session. */
  catalogSessionId: string;
  /** The CLI's own session id, once known — see AgentAdapter.canForceSessionId. */
  externalSessionId: string | null;
  /** A handoff summary from a different agent this session was just swapped
   * from (see agents/handoff.ts) — only relevant when there's no recorded
   * session to resume; adapters launch with this as the first turn's prompt
   * instead of a bare launch. Never set for an ordinary fresh/resumed
   * launch. */
  seedPrompt?: string;
}

export type ForkResult = { ok: true; externalId: string } | { ok: false; reason: string };

/**
 * One implementation per real CLI coding agent MetaHarn can drop a terminal
 * session into (Claude Code, Codex, Gemini). The one structural fork all of
 * these share: Claude Code can be *told* its own session id up front
 * (`--session-id <uuid>`), so MetaHarn's own catalog row id doubles as the
 * CLI's id. Codex and Gemini generate their own id and only reveal it after
 * the fact (see canForceSessionId) — MetaHarn has to discover it, which is
 * why `externalSessionId` exists as a value distinct from the catalog id.
 */
export interface AgentAdapter {
  readonly kind: AgentKind;
  readonly displayName: string;
  /** The binary name checked via `which` for install detection. */
  readonly binary: string;
  /** True only for Claude — see the interface doc above. */
  readonly canForceSessionId: boolean;
  /** The npm package this CLI is published as — used for latest-version
   * lookups (npm registry) and as the default install/uninstall/upgrade
   * mechanism, since npm is each one's official install path (even where a
   * self-updating native installer also exists for it). */
  readonly npmPackage: string;
  /** argv (not a shell string — always run via execFile, never a shell) for
   * this CLI's own self-update mechanism, when one exists and is confirmed
   * to work regardless of how the binary was actually installed (safer
   * than npm when available, since npm can't upgrade a binary it didn't
   * install). Falls back to `npm install -g <npmPackage>@latest` when
   * absent — see agents/lifecycle.ts. */
  readonly selfUpdateCommand?: string[];

  /** The shell line to type into the pty to launch or resume this agent. */
  buildLaunchCommand(opts: LaunchOpts): string;

  /** Whether `externalId` has a real, resumable transcript on disk yet. */
  hasRecordedSession(cwd: string, externalId: string): boolean;

  /**
   * Best-effort discovery of a just-created session's real external id, for
   * adapters where canForceSessionId is false. Returns null (never throws)
   * when nothing confidently identifiable exists yet — an expected,
   * retryable state, not an error. Never called for Claude.
   */
  discoverExternalSessionId?(opts: { cwd: string; sinceMs: number }): Promise<string | null>;

  /** Copies sourceExternalId's transcript to newExternalId. Fails soft with
   * a reason rather than writing a possibly-broken copy when unsure. */
  forkSession(cwd: string, sourceExternalId: string, newExternalId: string): ForkResult;

  /** Parses real usage stats from the CLI's own transcript file. Null when
   * there's nothing to read yet or the format can't be parsed. */
  getStats(cwd: string, externalId: string): TerminalSessionStats | null;

  /**
   * Non-interactively asks THIS agent, resumed against its own real
   * session, for a short handoff summary a DIFFERENT agent can continue
   * from — see agents/handoff.ts. Returns null (never throws) if the
   * session isn't resumable, the command errors, or it times out; callers
   * treat that as "no context available" and the swap proceeds fresh, same
   * contract as discoverExternalSessionId's "not found yet" case. Absent
   * for adapters that can never have a resumable session to summarize
   * (Gemini, in this build).
   */
  summarizeForHandoff?(cwd: string, externalId: string): Promise<string | null>;
}
