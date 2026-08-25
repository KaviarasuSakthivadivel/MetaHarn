import { getAdapter } from "./registry.js";
import { HANDOFF_PROMPT, type AgentKind } from "./types.js";

export { HANDOFF_PROMPT };

/**
 * Asks the OUTGOING agent to summarize itself for a swap, rather than
 * MetaHarn re-parsing its raw transcript and running a separate
 * summarization call — reuses each adapter's own resume plumbing, and the
 * agent that actually had the context produces a better summary of it
 * (including tool calls/decisions) than a reconstruction from raw JSONL
 * would. Never throws — a failed/timed-out/unsupported handoff just means
 * the swap proceeds fresh, same "degrade gracefully" contract as the rest
 * of the adapter code (e.g. hasRecordedSession's "nothing recorded yet").
 */
export async function generateHandoffSummary(
  cwd: string,
  fromKind: AgentKind,
  externalId: string | null,
): Promise<string | null> {
  if (!externalId) return null;
  const adapter = getAdapter(fromKind);
  if (!adapter.summarizeForHandoff) return null;
  try {
    return await adapter.summarizeForHandoff(cwd, externalId);
  } catch {
    return null;
  }
}
