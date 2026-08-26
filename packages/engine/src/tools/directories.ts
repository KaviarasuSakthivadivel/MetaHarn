/**
 * `request_directory` — the agent asks the user to grant access to a folder outside the
 * ones it already has.
 *
 * Ported from OpenWorker's coworker/tools/directories.py. There the TurnEngine intercepts
 * the call (a DIRECTORY_REQUESTED event resolved out-of-band by the GUI, e.g. a native
 * folder picker); this engine has no per-tool UI slot, so the real work is an injected async
 * callback the factory closes over. With no callback (a headless surface) execute() returns
 * the same fallback shape the Python original returns — it never throws.
 */
import type { ToolDefinition, ToolSchema } from "../types.js";

export interface DirectoryRequest {
  /** Why the task needs this folder — shown to the user alongside the prompt. */
  reason: string;
  /** Suggested path, if the agent has one; the user may pick a different folder instead. */
  path?: string;
  /** True when the agent needs write access, not just read. */
  writable: boolean;
  /** True only when the granted folder should replace the session's scratch directory as
   * its main workspace — allowed once, and only while still running on the scratch root. */
  primary: boolean;
}

export interface DirectoryGrant {
  granted: boolean;
  /** The access actually granted — may come back false even when `writable: true` was
   * requested (the user downgraded to read-only), so the agent must check this rather than
   * assume its request was honored verbatim. */
  writable?: boolean;
  /** The folder the user picked/approved, when granted. */
  path?: string;
  error?: string;
}

const REQUEST_DIRECTORY_SCHEMA: ToolSchema = {
  type: "function",
  function: {
    name: "request_directory",
    description:
      "Ask the user for access to a directory when the task needs files outside the current " +
      "ones (e.g. to read a project the user mentioned, or to save a deliverable somewhere " +
      "specific). Explain why in `reason`; optionally suggest a `path` and whether you need " +
      "`writable` access. Set `primary=true` only when the granted folder should become the " +
      "session's main workspace (the project the whole conversation is about) — allowed once, " +
      "and only while the session is still running on its scratch directory. The user " +
      "picks/approves the folder; the result says whether it was granted. Do not use this to " +
      "escape sandboxing — only to serve the user's request.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Why the task needs this directory." },
        path: { type: "string", description: "Suggested path, if you have one." },
        writable: { type: "boolean", description: "Whether write access is needed." },
        primary: {
          type: "boolean",
          description: "Whether this should become the session's main workspace.",
        },
      },
      required: ["reason"],
    },
  },
};

function parseArgs(args: Record<string, unknown>): DirectoryRequest {
  const path = args.path;
  return {
    reason: String(args.reason ?? ""),
    ...(path !== undefined ? { path: String(path) } : {}),
    writable: Boolean(args.writable ?? false),
    primary: Boolean(args.primary ?? false),
  };
}

/** Fallback returned when no `requestDirectory` callback is wired — mirrors directories.py's
 * headless body. */
const NO_REQUESTER_FALLBACK: DirectoryGrant = {
  granted: false,
  error: "directory requests aren't available in this surface",
};

/**
 * Build the `request_directory` tool. `requestDirectory` performs the real out-of-band grant
 * round-trip. When omitted — a headless surface — execute() returns the same safe fallback
 * the Python original returns, and never throws; a callback that itself rejects is likewise
 * turned into a `{granted: false, error}` result rather than propagating.
 */
export function createRequestDirectoryTool(
  requestDirectory?: (request: DirectoryRequest) => Promise<DirectoryGrant>,
): ToolDefinition {
  return {
    name: "request_directory",
    schema: REQUEST_DIRECTORY_SCHEMA,
    metadata: {
      category: "filesystem",
      riskLevel: "low",
      risk: "read",
      capabilities: ["request_directory"],
    },
    execute: async (args: Record<string, unknown>): Promise<unknown> => {
      if (!requestDirectory) return NO_REQUESTER_FALLBACK;
      try {
        return await requestDirectory(parseArgs(args));
      } catch (err) {
        return { granted: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
