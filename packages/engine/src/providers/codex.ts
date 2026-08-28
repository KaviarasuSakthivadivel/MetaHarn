/**
 * `openai-codex` provider — OpenAI models through a ChatGPT subscription instead of an API key.
 *
 * The backend speaks the same Responses wire as `/v1/responses` (stateless: full history each
 * turn, `store: false`, encrypted reasoning in the `_openaiResponses` sidecar), so all
 * conversion/parsing is inherited from `OpenAIResponsesProvider` (openaiResponses.ts) — this
 * subclass only swaps the credential: a short-lived OAuth bearer from `codexAuth.ts` instead of
 * an API key, plus the account/originator/session headers the backend requires. Ported from
 * OpenWorker's `coworker/providers/codex_provider.py`.
 *
 * Differences from the API-key path:
 *   - The backend serves streamed responses only, so `complete()` drains `stream()`.
 *   - 401 → one refresh-and-retry (the bearer died mid-flight); a rejected refresh token
 *     surfaces as a typed sign-in-required error, never a crash loop.
 *   - 429 → the plan's rolling usage window, surfaced as a user-readable message.
 *
 * Telemetry note: Laminar's OpenAI instrumentation DOES patch `Responses.prototype.create`
 * (verified directly against `@traceloop/instrumentation-openai`'s compiled output, not
 * assumed — the same "check, don't assume" bar this app's telemetry integration was held to
 * elsewhere). It does NOT capture streamed Responses calls' output/usage though — only request
 * attributes, closing the span immediately rather than waiting on the stream — and every call
 * through this provider streams (see above). So traces for this provider exist and are
 * correctly grouped, just without response content — a real gap, not a total blind spot like
 * Bedrock's.
 */
import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import type { AssistantTurn, CompletionRequest } from "../types.js";
import type { ProviderClient } from "./base.js";
import type { SecretStore } from "../trust/secretStore.js";
import { CODEX_BASE_URL, CodexTokenStore, PLAN_LIMIT_ERROR, backendHeaders } from "./codexAuth.js";
import { OpenAIResponsesProvider } from "./openaiResponses.js";

function statusCode(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

export class CodexProvider extends OpenAIResponsesProvider implements ProviderClient {
  private readonly store: CodexTokenStore;
  private readonly sessionId: string;
  private cachedToken: string | undefined;

  constructor(secrets: SecretStore) {
    // The real client is built lazily in ensureClient() once a bearer is available —
    // this placeholder key is never actually used to make a request.
    super({ apiKey: "pending-oauth-token", baseURL: CODEX_BASE_URL, reasoningSummary: true });
    this.store = new CodexTokenStore(secrets);
    // One conversation per provider instance in practice (session.ts caches one client per
    // provider); a uuid per instance satisfies the per-conversation session header without
    // threading conversation ids through ProviderClient.
    this.sessionId = randomUUID();
  }

  /** The bearer is short-lived: fetch per call (refreshes itself near expiry) and rebuild the
   * SDK client whenever the token rotated. */
  protected async ensureClient(): Promise<OpenAI> {
    const { token, accountId } = await this.store.accessToken();
    if (token !== this.cachedToken) {
      this.client = new OpenAI({ apiKey: token, baseURL: CODEX_BASE_URL, defaultHeaders: backendHeaders(accountId, this.sessionId) });
      this.cachedToken = token;
    }
    return this.client;
  }

  protected requestKwargs(req: CompletionRequest): Record<string, unknown> {
    const kwargs = super.requestKwargs(req);
    // This backend 400s ("Unsupported parameter") on standard sampling/cap knobs — confirmed
    // live against OpenWorker's own integration. Callers may pass them freely; they just
    // cannot ride to this backend.
    for (const unsupported of ["max_output_tokens", "temperature", "top_p"]) delete kwargs[unsupported];
    // Unlike stock /v1/responses, this backend honors a reasoning effort knob.
    const effort = req.settings?.reasoning_effort;
    if (typeof effort === "string" && effort) {
      kwargs.reasoning = { ...(kwargs.reasoning as Record<string, unknown> | undefined), effort };
    }
    // The backend rejects requests without instructions; history normally carries a system
    // prompt — this is only the bare-call fallback.
    if (!kwargs.instructions) kwargs.instructions = "You are a helpful assistant.";
    return kwargs;
  }

  protected async createStream(
    kwargs: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<AsyncIterable<OpenAI.Responses.ResponseStreamEvent>> {
    try {
      return await super.createStream(kwargs, signal);
    } catch (err) {
      const status = statusCode(err);
      if (status === 401) {
        // The bearer died mid-flight: force one refresh and retry once. A rejected refresh
        // raises CodexSignInRequiredError out of the store.
        await this.store.refresh();
        this.cachedToken = undefined;
        return await super.createStream(kwargs, signal);
      }
      if (status === 429) throw new Error(PLAN_LIMIT_ERROR);
      throw err;
    }
  }

  // The backend only serves streamed responses — aggregate the stream rather than using the
  // base class's non-streaming complete().
  async complete(req: CompletionRequest): Promise<AssistantTurn> {
    let turn: AssistantTurn | undefined;
    for await (const chunk of this.stream(req)) {
      if (chunk.turn) turn = chunk.turn;
    }
    return turn ?? { toolCalls: [] };
  }
}
