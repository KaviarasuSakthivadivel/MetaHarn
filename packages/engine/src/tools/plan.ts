/**
 * `propose_plan` — the agent presents its plan and asks the user to approve leaving
 * read-only plan mode.
 *
 * Ported from OpenWorker's coworker/tools/plan.py. Register this tool only for a session
 * that started in plan mode — that decision belongs to whoever wires up the
 * ToolRegistry/PermissionEvaluator, not to this module. There the TurnEngine intercepts the
 * call (a PLAN_PROPOSED event resolved out-of-band; approval flips the live
 * PermissionEngine out of plan mode with the session's exploration context kept); this
 * engine has no per-tool UI slot, so the real work is an injected async callback the factory
 * closes over. With no callback (a headless surface) execute() returns the same fallback
 * shape the Python original returns — it never throws.
 */
import type { ToolDefinition, ToolSchema } from "../types.js";

export interface PlanProposal {
  plan: string;
}

export interface PlanDecision {
  approved: boolean;
  /** The user's revision notes — present when `approved` is false so the agent can revise. */
  feedback?: string;
  error?: string;
}

const PROPOSE_PLAN_SCHEMA: ToolSchema = {
  type: "function",
  function: {
    name: "propose_plan",
    description:
      "Present your implementation plan to the user for approval. Use this once you have " +
      "explored enough to commit to an approach: summarize what you'll change, in which " +
      "files, and how you'll verify it. If approved, the session switches out of read-only " +
      "plan mode and you implement the plan; if rejected, revise it using the feedback in " +
      "the result. Don't start describing implementation steps as if you were doing them — " +
      "propose first.",
    parameters: {
      type: "object",
      properties: {
        plan: { type: "string", description: "The plan to present, in plain language." },
      },
      required: ["plan"],
    },
  },
};

function parseArgs(args: Record<string, unknown>): PlanProposal {
  return { plan: String(args.plan ?? "") };
}

/** Fallback returned when no `proposePlan` callback is wired — mirrors plan.py's headless
 * body. */
const NO_APPROVER_FALLBACK: PlanDecision = {
  approved: false,
  error: "plan approval isn't available in this surface",
};

/**
 * Build the `propose_plan` tool. `proposePlan` performs the real out-of-band approval
 * round-trip. When omitted — a headless surface — execute() returns the same safe fallback
 * the Python original returns, and never throws; a callback that itself rejects is likewise
 * turned into an `{approved: false, error}` result rather than propagating.
 */
export function createProposePlanTool(
  proposePlan?: (proposal: PlanProposal) => Promise<PlanDecision>,
): ToolDefinition {
  return {
    name: "propose_plan",
    schema: PROPOSE_PLAN_SCHEMA,
    metadata: {
      category: "planning",
      riskLevel: "low",
      risk: "read",
      capabilities: ["plan"],
    },
    execute: async (args: Record<string, unknown>): Promise<unknown> => {
      if (!proposePlan) return NO_APPROVER_FALLBACK;
      try {
        return await proposePlan(parseArgs(args));
      } catch (err) {
        return { approved: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
