/**
 * Provider-agnostic model access layer. The engine never imports a vendor SDK directly —
 * it talks to a ProviderClient. See providers/router.ts for the provider:model dispatcher,
 * and Tier 7's providers-impl workstream for concrete Anthropic/OpenAI clients.
 *
 * Deliberately just two methods: no max-turns loop here — the engine owns the agent loop.
 */
import type { AssistantTurn, CompletionRequest, ModelCapabilities, StreamChunk } from "../types.js";

export interface ProviderClient {
  complete(req: CompletionRequest): Promise<AssistantTurn>;

  /**
   * Yield StreamChunks. A provider with no real token streaming may implement this as a
   * single-chunk async generator wrapping complete() — see providers/router.ts's
   * defaultStream() helper.
   */
  stream(req: CompletionRequest): AsyncIterable<StreamChunk>;

  capabilities(model: string): ModelCapabilities;
}

/** Helper for a provider with no real streaming: one final chunk carrying the whole turn. */
export async function* defaultStream(
  complete: (req: CompletionRequest) => Promise<AssistantTurn>,
  req: CompletionRequest,
): AsyncIterable<StreamChunk> {
  yield { turn: await complete(req) };
}
