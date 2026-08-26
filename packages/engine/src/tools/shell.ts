/**
 * `run_shell` — the base shell-execution tool.
 *
 * Not part of the OpenWorker feature catalog (see files.ts's module doc for why) — but the
 * exact name `run_shell` and its `command` argument are load-bearing: `permissions/risk.ts`'s
 * `SHELL_TOOL_NAME`, `permissions/engine.ts`, `permissions/shellAllowlist.ts`,
 * `permissions/readonlyClassifier.ts`, and `trust/provenance.ts`'s default `shellToolName` were
 * all written assuming a tool with exactly this shape.
 */
import { spawn } from "node:child_process";
import type { ToolDefinition } from "../types.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_CHARS = 100_000;

function truncate(text: string): { text: string; truncated: boolean } {
  return text.length > MAX_OUTPUT_CHARS
    ? { text: text.slice(0, MAX_OUTPUT_CHARS), truncated: true }
    : { text, truncated: false };
}

export function createRunShellTool(workspace: string): ToolDefinition {
  return {
    name: "run_shell",
    schema: {
      type: "function",
      function: {
        name: "run_shell",
        description:
          "Run a shell command in the workspace and return its stdout/stderr/exit code. The " +
          "command runs through the user's shell (so pipes, &&, globs, etc. all work) — write it " +
          "as you would type it in a terminal.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "The command to run." },
            timeout_ms: {
              type: "integer",
              description: `Max time to allow (default ${DEFAULT_TIMEOUT_MS}ms, capped at ${MAX_TIMEOUT_MS}ms).`,
            },
          },
          required: ["command"],
        },
      },
    },
    // risk left undeclared (falls through to risk.ts's SHELL_TOOL_NAME floor) for the same
    // reason write_file's does — the floor exists so this can't get it wrong.
    metadata: { category: "shell", riskLevel: "high", requiresApproval: true },
    execute: (args, ctx) => {
      const command = String(args.command ?? "");
      const timeoutMs = Math.min(
        typeof args.timeout_ms === "number" && args.timeout_ms > 0 ? args.timeout_ms : DEFAULT_TIMEOUT_MS,
        MAX_TIMEOUT_MS,
      );
      return new Promise((resolve) => {
        const shell = process.platform === "win32" ? true : "/bin/sh";
        const child = spawn(command, {
          cwd: workspace,
          shell,
          signal: ctx.signal,
          timeout: timeoutMs,
        });
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        child.on("error", (err) => {
          resolve({ error: err.message, stdout: truncate(stdout).text, stderr: truncate(stderr).text });
        });
        child.on("close", (code, signal) => {
          const out = truncate(stdout);
          const err = truncate(stderr);
          resolve({
            exitCode: code,
            signal,
            stdout: out.text,
            stderr: err.text,
            truncated: out.truncated || err.truncated,
          });
        });
      });
    },
  };
}
