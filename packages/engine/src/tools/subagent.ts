/**
 * The `explore` tool — a read-only research subagent with its own context window.
 *
 * Broad questions ("where is retry logic handled?") burn the main session's context on
 * dozens of file reads. `explore` spawns a child Engine with read-only tools and a fresh
 * context; only its final report returns to the caller.
 *
 * The child gets a trivial always-allow PermissionEvaluator rather than a real PLAN-mode
 * gate: unlike OpenWorker's Python PermissionEngine (which still has to hard-block
 * writes/shell in case a caller mis-wires the registry), the child registry here is built
 * exclusively from `opts.readOnlyTools()` — there is nothing risky to gate, so real
 * permission logic would be dead weight. That's also what lets `explore` carry low-risk
 * ("read") metadata, making several explore calls in one assistant turn eligible for the
 * parent engine's parallel (Promise.all) execution path. No recursion: the child registry
 * is never given an `explore` tool of its own.
 *
 * Ported from OpenWorker's coworker/tools/subagent.py. The Python version shells out via
 * `asyncio.run` because its tools execute in a worker thread with no running loop; this
 * port just awaits the child engine's async generator directly on Node's single loop.
 */
import type { PermissionDecision, PermissionEvaluator, ToolDefinition, ToolExecutionContext, TurnEndStatus } from "../types.js";
import type { ProviderClient } from "../providers/base.js";
import { Engine } from "../engine.js";
import { ToolRegistry } from "./registry.js";

/** Verbatim port of OpenWorker's EXPLORER_INSTRUCTIONS (coworker/tools/subagent.py). */
export const EXPLORER_INSTRUCTIONS = `You are a read-only code explorer working inside the user's workspace. Answer the research task you're given by searching and reading the code (\`grep\`, \`read_file\`, \`list_files\`, \`git_log\`, \`git_status\`, \`git_diff\`). You cannot write files or run commands.

Your final message is your report — it goes back to the agent that spawned you, not to the user. Make it self-contained: answer the task directly, reference code as path:line, quote the key snippets, and note anything surprising you found along the way. If you couldn't find something, say what you searched so the caller doesn't repeat the same searches.`;

const CHILD_MAX_ITERATIONS = 10;

/** Always-allow: the child registry only ever holds read-only tools, so real gating isn't
 * needed — a real PermissionEvaluator would just be dead weight here. */
const ALWAYS_ALLOW: PermissionEvaluator = {
  evaluate(): PermissionDecision {
    return { allowed: true, reason: "read-only child", needsUser: false, humanOnly: false };
  },
};

export interface CreateExploreToolOptions {
  provider: ProviderClient;
  model: string;
  /** Called fresh on every explore invocation so concurrent calls never share tool state. */
  readOnlyTools: () => ToolDefinition[];
}

interface ExploreResult {
  report?: string;
  note?: string;
  error?: string;
}

/**
 * Build the `explore` tool: delegate a broad, read-only research task to a subagent with
 * its own fresh context window. Safe to invoke several times concurrently within one
 * assistant turn — every call builds its own registry, permission evaluator, and Engine,
 * so there is no state shared across invocations.
 */
export function createExploreTool(opts: CreateExploreToolOptions): ToolDefinition {
  return {
    name: "explore",
    schema: {
      type: "function",
      function: {
        name: "explore",
        description:
          "Delegate a broad, read-only research task to a subagent with its own fresh context " +
          "window. It searches and reads the workspace, then returns only its final report — " +
          "the intermediate file reads never touch your context. Use it for multi-file questions " +
          '("where is X handled?", "how does the Y flow work?"); for a single known file, just ' +
          "read it yourself. Independent explore calls run in parallel when requested together. " +
          "State the task precisely and say what the report should include.",
        parameters: {
          type: "object",
          properties: {
            task: {
              type: "string",
              description:
                "The research question, with any constraints and the expected shape of the report.",
            },
          },
          required: ["task"],
          additionalProperties: false,
        },
      },
    },
    metadata: {
      category: "search",
      riskLevel: "low",
      risk: "read",
      capabilities: ["search"],
      requiresApproval: false,
    },
    execute: (args: Record<string, unknown>, ctx: ToolExecutionContext) => runExplore(opts, args, ctx),
  };
}

async function runExplore(
  opts: CreateExploreToolOptions,
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<ExploreResult> {
  const task = args.task;
  if (typeof task !== "string" || !task.trim()) {
    return { error: "explore requires a non-empty `task` string" };
  }

  const registry = new ToolRegistry();
  registry.registerAll(opts.readOnlyTools());

  const engine = new Engine({
    provider: opts.provider,
    registry,
    permissions: ALWAYS_ALLOW,
    model: opts.model,
    instructions: EXPLORER_INSTRUCTIONS,
    maxIterations: CHILD_MAX_ITERATIONS,
  });

  // If the parent turn is interrupted mid-explore, stop the child too instead of letting
  // it burn iterations toward a caller that's already gone.
  const onParentAbort = () => engine.requestInterrupt();
  if (ctx.signal.aborted) engine.requestInterrupt();
  else ctx.signal.addEventListener("abort", onParentAbort, { once: true });

  let report = "";
  let status: TurnEndStatus | "unknown" = "unknown";
  let errorMessage: string | undefined;

  try {
    for await (const event of engine.run(task)) {
      if (event.type === "assistant_message") {
        if (event.text) report = event.text;
      } else if (event.type === "turn_end") {
        status = event.status;
      } else if (event.type === "error") {
        errorMessage = event.error;
      }
    }
  } finally {
    ctx.signal.removeEventListener("abort", onParentAbort);
  }

  if (errorMessage) {
    return { error: `explorer failed: ${errorMessage}` };
  }
  if (!report) {
    return { error: `explorer produced no report (status: ${status})` };
  }

  const result: ExploreResult = { report };
  if (status !== "completed") {
    result.note = `explorer stopped early (${status}); the report may be partial`;
  }
  return result;
}
