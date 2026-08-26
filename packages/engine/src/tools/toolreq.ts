/**
 * `request_tool` — the agent asks the user to install a missing CLI from a small pinned
 * catalog, rather than silently skipping the check that needs it.
 *
 * Ported from OpenWorker's coworker/tools/toolreq.py (OPE-85: with gitleaks absent, a
 * security review silently dropped its git-history secret scan — the check didn't fail, it
 * vanished from the report; a missing tool must become a visible decision, never an
 * invisible gap). There the TurnEngine intercepts the call (a TOOL_REQUESTED event resolved
 * out-of-band); this engine has no per-tool UI slot, so the real work is an injected async
 * callback the factory closes over. With no callback (a headless surface) execute() returns
 * the same fallback shape the Python original returns — it never throws.
 */
import type { ToolDefinition, ToolSchema } from "../types.js";

export interface ToolInstallRequest {
  /** One of the pinned catalog tools — currently "gitleaks", "trivy", "osv-scanner". */
  name: string;
  /** One sentence: which check needs the tool. */
  reason: string;
}

export interface ToolInstallResult {
  installed: boolean;
  error?: string;
}

const REQUEST_TOOL_SCHEMA: ToolSchema = {
  type: "function",
  function: {
    name: "request_tool",
    description:
      "Ask the user to install one of the PINNED catalog tools you need but can't find on " +
      "this machine. The catalog is a small closed set — currently `gitleaks`, `trivy`, " +
      "`osv-scanner` — installed at a pinned, checksum-verified version. For ANY other " +
      "missing CLI (semgrep, jq, kubectl, …) do NOT use this tool: install it yourself with " +
      "the shell (goes through the normal command approval), or proceed without it. Keep " +
      "`reason` to ONE sentence: which check needs the tool — the prompt the user sees " +
      "already explains what the install is (pinned version, publisher, checksum) and what " +
      "happens if they decline; don't restate any of that. Use this INSTEAD of quietly " +
      "skipping a check. If the user declines, carry on with a fallback (e.g. reading git " +
      "history yourself instead of running gitleaks) and state plainly in your report which " +
      "checks were degraded and why.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The pinned catalog tool to install." },
        reason: { type: "string", description: "One sentence: which check needs it." },
      },
      required: ["name", "reason"],
    },
  },
};

function parseArgs(args: Record<string, unknown>): ToolInstallRequest {
  return {
    name: String(args.name ?? ""),
    reason: String(args.reason ?? ""),
  };
}

/** Fallback returned when no `requestTool` callback is wired — mirrors toolreq.py's headless
 * body. */
const NO_REQUESTER_FALLBACK: ToolInstallResult = {
  installed: false,
  error: "tool requests aren't available in this surface",
};

/**
 * Build the `request_tool` tool. `requestTool` performs the real out-of-band install
 * round-trip. When omitted — a headless surface — execute() returns the same safe fallback
 * the Python original returns, and never throws; a callback that itself rejects is likewise
 * turned into an `{installed: false, error}` result rather than propagating.
 */
export function createRequestToolTool(
  requestTool?: (request: ToolInstallRequest) => Promise<ToolInstallResult>,
): ToolDefinition {
  return {
    name: "request_tool",
    schema: REQUEST_TOOL_SCHEMA,
    metadata: {
      category: "system",
      riskLevel: "low",
      risk: "read",
      capabilities: ["request_tool"],
    },
    execute: async (args: Record<string, unknown>): Promise<unknown> => {
      if (!requestTool) return NO_REQUESTER_FALLBACK;
      try {
        return await requestTool(parseArgs(args));
      } catch (err) {
        return { installed: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
