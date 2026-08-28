/**
 * OpenAI Responses-API provider — `/v1/responses` (or a Responses-compatible backend).
 *
 * Ported from OpenWorker's `coworker/providers/openai_responses.py`: same converters, same
 * edge cases. This exists alongside `openai.ts` (Chat Completions) because the ChatGPT
 * subscription backend (`codex.ts`) speaks the Responses wire ONLY — Chat Completions isn't
 * reachable through a ChatGPT plan at all, only through a metered API key. Nothing about this
 * provider is subscription-specific; `codex.ts` is a thin subclass that only swaps the
 * credential.
 *
 * What the converters have to absorb, relative to Chat Completions:
 * - The system prompt is the `instructions` request field, not a message role.
 * - Assistant tool calls are top-level `function_call` items; tool results are
 *   `function_call_output` items paired by `call_id` (ids only need to pair up, so a foreign
 *   `toolu_…` id from a mid-conversation provider switch is fine).
 * - Tool schemas are FLAT (`{type: "function", name, ...}` — no nested `function` key).
 * - Reasoning continuity: raw output items (a reasoning item with `encrypted_content`,
 *   `function_call` items with their ids) ride the canonical assistant message as an
 *   `_openaiResponses` sidecar (`AssistantTurn.extras`, same mechanism as Gemini's
 *   `_gemini` thought-signature sidecar in gemini.ts). Present → replayed verbatim for exact
 *   chain-of-thought continuity; absent (history from another provider) → items are
 *   synthesized from the canonical fields. A reasoning item WITHOUT `encrypted_content` never
 *   enters the sidecar: with `store: false` the server can't resolve it by id and would reject
 *   the replay.
 */
import OpenAI from "openai";
import type {
  AssistantTurn,
  ChatMessage,
  CompletionRequest,
  ModelCapabilities,
  StreamChunk,
  ToolCall,
  ToolSchema,
  TokenUsage,
} from "../types.js";
import type { ProviderClient } from "./base.js";

// Request params passed through from model settings; everything else is dropped.
const SETTINGS_WHITELIST = ["temperature", "top_p", "max_output_tokens", "tool_choice", "parallel_tool_calls"] as const;

// "Unsupported parameter: 'temperature' is not supported with this model." — reasoning models
// reject sampling params; non-reasoning models reject `reasoning`/`include`. The server names
// exactly one offender per error, so each retry drops exactly that.
const UNSUPPORTED_PARAM_RE = /unsupported (?:parameter|value)s?:?\s*'([^']+)'/i;

function paramFixRetry(kwargs: Record<string, unknown>, message: string): Record<string, unknown> | undefined {
  const match = UNSUPPORTED_PARAM_RE.exec(message.toLowerCase());
  if (!match) return undefined;
  const param = match[1].split(".")[0].split("[")[0];
  if (param in kwargs && param !== "model" && param !== "input") {
    const fixed = { ...kwargs };
    delete fixed[param];
    return fixed;
  }
  return undefined;
}

function userContent(content: ChatMessage["content"]): unknown {
  if (typeof content === "string") return content;
  const parts: Record<string, unknown>[] = [];
  for (const part of content ?? []) {
    if (part.type === "text") parts.push({ type: "input_text", text: part.text });
    else if (part.type === "image_url") parts.push({ type: "input_image", image_url: part.image_url.url });
    else if (part.type === "file") {
      const entry: Record<string, unknown> = { type: "input_file" };
      if (part.file.filename) entry.filename = part.file.filename;
      if (part.file.file_data) entry.file_data = part.file.file_data;
      parts.push(entry);
    }
  }
  return parts;
}

function synthesizedItems(message: ChatMessage): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  if (typeof message.content === "string" && message.content) items.push({ role: "assistant", content: message.content });
  for (const call of message.toolCalls ?? []) {
    items.push({ type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments });
  }
  return items;
}

interface ResponsesSidecar {
  items?: Record<string, unknown>[];
}

/** Canonical OpenAI-chat-shaped history → (`instructions`, Responses `input` items). Leading
 * system messages join into `instructions`; a stray mid-thread system message rides as a
 * system message item. Assistant messages replay their `_openaiResponses` sidecar verbatim
 * when present, else synthesize from canonical fields. */
function convertMessages(messages: ChatMessage[]): { instructions?: string; items: Record<string, unknown>[] } {
  const systemParts: string[] = [];
  let i = 0;
  while (i < messages.length && messages[i].role === "system") {
    const content = messages[i].content;
    if (typeof content === "string" && content) systemParts.push(content);
    i++;
  }

  const items: Record<string, unknown>[] = [];
  for (const message of messages.slice(i)) {
    if (message.role === "system") {
      const text = typeof message.content === "string" ? message.content : "";
      if (text) items.push({ role: "system", content: text });
    } else if (message.role === "user") {
      const content = userContent(message.content);
      if ((typeof content === "string" && content) || (Array.isArray(content) && content.length)) {
        items.push({ role: "user", content });
      }
    } else if (message.role === "assistant") {
      const sidecar = (message._openaiResponses as ResponsesSidecar | undefined) ?? {};
      const replay = sidecar.items ?? [];
      items.push(...(replay.length ? replay : synthesizedItems(message)));
    } else if (message.role === "tool") {
      const content = message.content;
      items.push({
        type: "function_call_output",
        call_id: message.toolCallId ?? "",
        output: typeof content === "string" ? content : String(content ?? ""),
      });
    }
  }

  return { instructions: systemParts.join("\n\n") || undefined, items };
}

function convertTools(tools: ToolSchema[] | undefined): Record<string, unknown>[] {
  const converted: Record<string, unknown>[] = [];
  for (const tool of tools ?? []) {
    const fn = tool.function;
    if (!fn?.name) continue;
    const entry: Record<string, unknown> = { type: "function", name: fn.name };
    if (fn.description) entry.description = fn.description;
    if (fn.parameters !== undefined) entry.parameters = fn.parameters;
    converted.push(entry);
  }
  return converted;
}

function parseArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(String(raw));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { _raw: raw };
  } catch {
    return { _raw: raw };
  }
}

/** Output items → the `_openaiResponses` sidecar, or {} when replay would add nothing.
 * Reasoning items without `encrypted_content` are dropped (see module doc). */
function sidecarExtras(items: Record<string, unknown>[]): Record<string, unknown> {
  const kept = items.filter((item) => item.type !== "reasoning" || item.encrypted_content);
  const worthKeeping = kept.some((item) => item.type === "reasoning" || item.type === "function_call");
  return worthKeeping ? { _openaiResponses: { items: kept } } : {};
}

function usageFrom(usage: OpenAI.Responses.ResponseUsage | null | undefined): TokenUsage | undefined {
  if (!usage) return undefined;
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  return { input: Math.max(usage.input_tokens - cached, 0), output: usage.output_tokens, cacheRead: cached, cacheWrite: 0 };
}

/** One Responses result → an AssistantTurn (+ sidecar extras). Items are treated loosely
 * (`Record<string, unknown>`) rather than through the SDK's full output-item union: they need
 * to round-trip as both read (from a typed SDK response) and write (raw JSON sent back next
 * turn) shapes, which the union isn't set up for. */
function parseResponse(response: OpenAI.Responses.Response): AssistantTurn {
  const items = (response.output ?? []) as unknown as Record<string, unknown>[];
  const texts: string[] = [];
  const summaries: string[] = [];
  const toolCalls: ToolCall[] = [];

  for (const item of items) {
    const kind = item.type;
    if (kind === "message" || (kind === undefined && "content" in item)) {
      const content = item.content;
      if (typeof content === "string") texts.push(content);
      else if (Array.isArray(content)) {
        for (const part of content as Record<string, unknown>[]) {
          if (part.type === "output_text" && typeof part.text === "string") texts.push(part.text);
        }
      }
    } else if (kind === "reasoning") {
      for (const part of (item.summary as Record<string, unknown>[] | undefined) ?? []) {
        const text = typeof part === "string" ? part : (part as Record<string, unknown>).text;
        if (typeof text === "string" && text) summaries.push(text);
      }
    } else if (kind === "function_call") {
      toolCalls.push({
        id: (item.call_id as string) || (item.id as string) || "",
        name: (item.name as string) || "",
        arguments: parseArguments(item.arguments),
      });
    }
  }

  const incompleteReason = response.incomplete_details?.reason;
  const finish = toolCalls.length ? "tool_calls" : incompleteReason === "max_output_tokens" ? "length" : "stop";

  return {
    text: texts.join("") || undefined,
    toolCalls,
    finishReason: finish,
    reasoning: summaries.join("") || undefined,
    extras: sidecarExtras(items),
    usage: usageFrom(response.usage),
    raw: response,
  };
}

export interface OpenAIResponsesProviderOptions {
  apiKey: string;
  /** Responses-compatible endpoints only (the stock `openai` default is left unset). */
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
  reasoningSummary?: boolean;
}

export class OpenAIResponsesProvider implements ProviderClient {
  protected client: OpenAI;
  private readonly reasoningSummary: boolean;

  constructor(opts: OpenAIResponsesProviderOptions) {
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL, defaultHeaders: opts.defaultHeaders });
    this.reasoningSummary = opts.reasoningSummary ?? true;
  }

  /** Seam for a subclass with a rotating credential (codex.ts): overridden to fetch a fresh
   * bearer per call and rebuild the client when the token has changed since the last one.
   * The base implementation is static — the client built at construction never changes. */
  protected async ensureClient(): Promise<OpenAI> {
    return this.client;
  }

  protected requestKwargs(req: CompletionRequest): Record<string, unknown> {
    const { instructions, items } = convertMessages(req.messages);
    const settings = req.settings ?? {};
    const maxOutputTokens = typeof settings.max_output_tokens === "number" ? settings.max_output_tokens : settings.max_tokens;
    const kwargs: Record<string, unknown> = {
      model: req.model,
      input: items,
      // Stateless: nothing retained server-side; encrypted reasoning rides the sidecar
      // instead, and summaries feed the reasoning-delta stream.
      store: false,
      include: ["reasoning.encrypted_content"],
    };
    for (const key of SETTINGS_WHITELIST) if (settings[key] !== undefined) kwargs[key] = settings[key];
    if (typeof maxOutputTokens === "number") kwargs.max_output_tokens = maxOutputTokens;
    if (this.reasoningSummary) kwargs.reasoning = { summary: "auto" };
    if (instructions) kwargs.instructions = instructions;
    const tools = convertTools(req.tools);
    if (tools.length) kwargs.tools = tools;
    return kwargs;
  }

  /** Up to three param-fix retries: sampling params, `reasoning`, and `include` can each need
   * dropping depending on the model (reasoning vs not). */
  protected async create(kwargs: Record<string, unknown>, signal?: AbortSignal): Promise<OpenAI.Responses.Response> {
    const client = await this.ensureClient();
    let attempt = kwargs;
    for (let i = 0; i < 3; i++) {
      try {
        return (await client.responses.create(
          attempt as unknown as OpenAI.Responses.ResponseCreateParamsNonStreaming,
          { signal },
        )) as OpenAI.Responses.Response;
      } catch (err) {
        const fixed = paramFixRetry(attempt, (err as Error).message ?? "");
        if (!fixed) throw err;
        attempt = fixed;
      }
    }
    return (await client.responses.create(
      attempt as unknown as OpenAI.Responses.ResponseCreateParamsNonStreaming,
      { signal },
    )) as OpenAI.Responses.Response;
  }

  protected async createStream(
    kwargs: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<AsyncIterable<OpenAI.Responses.ResponseStreamEvent>> {
    const client = await this.ensureClient();
    let attempt = { ...kwargs, stream: true };
    for (let i = 0; i < 3; i++) {
      try {
        return await client.responses.create(attempt as unknown as OpenAI.Responses.ResponseCreateParamsStreaming, { signal });
      } catch (err) {
        const fixed = paramFixRetry(attempt, (err as Error).message ?? "");
        if (!fixed) throw err;
        attempt = { ...fixed, stream: true };
      }
    }
    return await client.responses.create(attempt as unknown as OpenAI.Responses.ResponseCreateParamsStreaming, { signal });
  }

  async complete(req: CompletionRequest): Promise<AssistantTurn> {
    const response = await this.create(this.requestKwargs(req), req.signal);
    return parseResponse(response);
  }

  async *stream(req: CompletionRequest): AsyncIterable<StreamChunk> {
    const events = await this.createStream(this.requestKwargs(req), req.signal);

    const textParts: string[] = [];
    const reasoningParts: string[] = [];
    const doneItems: Record<string, unknown>[] = [];
    let final: OpenAI.Responses.Response | undefined;

    for await (const event of events) {
      if (event.type === "response.output_text.delta") {
        if (event.delta) {
          textParts.push(event.delta);
          yield { textDelta: event.delta };
        }
      } else if (event.type === "response.reasoning_summary_text.delta") {
        if (event.delta) {
          reasoningParts.push(event.delta);
          yield { reasoningDelta: event.delta };
        }
      } else if (event.type === "response.output_item.done") {
        if (event.item) doneItems.push(event.item as unknown as Record<string, unknown>);
      } else if (event.type === "response.completed" || event.type === "response.incomplete" || event.type === "response.failed") {
        final = (event as { response?: OpenAI.Responses.Response }).response;
      }
    }

    if (final) {
      // The terminal event carries the full response — parse it whole so tool calls, finish
      // reason, and the sidecar all come from one place. Some Responses-compatible backends
      // (the ChatGPT subscription backend) leave the terminal response's `output` EMPTY — the
      // items only ever stream — so graft the streamed output_item.done items back on before
      // parsing, or a turn's text and tool calls silently vanish.
      const finalOutput = (final.output ?? []) as unknown[];
      if (!finalOutput.length && doneItems.length) (final as { output?: unknown[] }).output = doneItems;
      const turn = parseResponse(final);
      yield { turn: { ...turn, text: turn.text ?? (textParts.join("") || undefined) } };
    } else {
      yield { turn: { text: textParts.join("") || undefined, toolCalls: [], reasoning: reasoningParts.join("") || undefined } };
    }
  }

  capabilities(model: string): ModelCapabilities {
    return { tools: true, vision: !model.endsWith("-mini"), pdf: false, parallelToolCalls: true, streaming: true };
  }
}
