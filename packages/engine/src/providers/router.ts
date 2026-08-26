/**
 * ProviderRouter — one ProviderClient that dispatches by the `provider:` prefix of a model
 * string to a per-provider client, built lazily via an injected factory and cached.
 *
 * `ollama:llama3.3` -> the "ollama" client; bare `claude-opus-4-5` -> the default provider.
 * The prefix is stripped before delegating (the underlying SDK wants the bare model name).
 *
 * Ported from OpenWorker's coworker/providers/router.py. One deliberate difference: that
 * version built clients from a secrets profile directly; here client construction is fully
 * injected (`ProviderFactory`), so this package stays independent of MetaHarn's secret
 * storage — the caller (apps/desktop, later) decides how a provider gets its API key.
 */
import type { AssistantTurn, CompletionRequest, ModelCapabilities, StreamChunk } from "../types.js";
import type { ProviderClient } from "./base.js";

export type ProviderFactory = (providerName: string) => ProviderClient;

export interface ProviderRouterOptions {
  /** Provider name -> client. Called at most once per name (results are cached). */
  buildClient: ProviderFactory;
  defaultProvider?: string;
  /**
   * Names the router treats as real provider prefixes when splitting `name:rest`. Anything
   * else with a colon (e.g. a version tag like `qwen2.5-coder:32b`) is left as one bare
   * model string for the default provider — the same gotcha OpenWorker's `_bare()` guards.
   */
  knownProviders: Iterable<string>;
  /** Fired (best-effort) whenever a completion is dispatched — e.g. for a "last used" UI. */
  onUse?: (providerName: string) => void;
}

export class ProviderRouter implements ProviderClient {
  private readonly buildClient: ProviderFactory;
  private readonly defaultProvider: string;
  private readonly known: Set<string>;
  private readonly onUse?: (providerName: string) => void;
  private readonly clients = new Map<string, ProviderClient>();

  constructor(opts: ProviderRouterOptions) {
    this.buildClient = opts.buildClient;
    this.defaultProvider = opts.defaultProvider ?? "anthropic";
    this.known = new Set(opts.knownProviders);
    this.onUse = opts.onUse;
  }

  private providerName(model: string): string {
    const i = model.indexOf(":");
    if (i === -1) return this.defaultProvider;
    const prefix = model.slice(0, i);
    return this.known.has(prefix) ? prefix : this.defaultProvider;
  }

  private bareModel(model: string): string {
    const i = model.indexOf(":");
    if (i === -1) return model;
    const prefix = model.slice(0, i);
    return this.known.has(prefix) ? model.slice(i + 1) : model;
  }

  private clientFor(model: string): ProviderClient {
    const name = this.providerName(model);
    let client = this.clients.get(name);
    if (!client) {
      client = this.buildClient(name);
      this.clients.set(name, client);
    }
    return client;
  }

  /** Drop cached client(s) so the next call rebuilds with fresh config (e.g. a new key). */
  invalidate(name?: string): void {
    if (name) this.clients.delete(name);
    else this.clients.clear();
  }

  async complete(req: CompletionRequest): Promise<AssistantTurn> {
    this.onUse?.(this.providerName(req.model));
    return this.clientFor(req.model).complete({ ...req, model: this.bareModel(req.model) });
  }

  stream(req: CompletionRequest): AsyncIterable<StreamChunk> {
    this.onUse?.(this.providerName(req.model));
    return this.clientFor(req.model).stream({ ...req, model: this.bareModel(req.model) });
  }

  capabilities(model: string): ModelCapabilities {
    return this.clientFor(model).capabilities(this.bareModel(model));
  }
}
