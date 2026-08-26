/**
 * OpenAI provider — Chat Completions API.
 *
 * The engine's canonical history (`ChatMessage[]`, types.ts) is already OpenAI-*shaped*, but
 * it is not the OpenAI SDK's actual param type: the canonical fields are camelCase
 * (`toolCalls`, `toolCallId`) where the wire is snake_case (`tool_calls`, `tool_call_id`), so
 * a real (if mostly 1:1) reshape is still needed — unlike OpenWorker's Python provider, which
 * could hand its already-snake_case dicts straight to the SDK.
 *
 * Two edge cases the Chat Completions streaming wire forces on every caller:
 * - Tool-call arguments stream as incremental JSON string *fragments*, keyed by an `index`
 *   that is stable within one response but says nothing about call order across chunks — they
 *   must be accumulated per index and JSON-parsed only once the stream ends.
 * - `usage` differs by whether prompt caching is active: `prompt_tokens` always *includes*
 *   any cached tokens, so the cached share (`prompt_tokens_details.cached_tokens`, only
 *   present when caching applied) is carved out into `cacheRead` and subtracted from `input`.
 */
import OpenAI from "openai";
import type {
  AssistantTurn,
  ChatMessage,
  CompletionRequest,
  ContentPart,
  ModelCapabilities,
  StreamChunk,
  ToolCall,
  ToolCallWire,
  ToolSchema,
  TokenUsage,
} from "../types.js";
import type { ProviderClient } from "./base.js";

// A ceiling, not a spend target — same rationale as the Anthropic provider: a tool call that
// writes a whole file inline in its arguments needs real headroom, and a lot of servers
// default far lower than that on their own.
const DEFAULT_MAX_TOKENS = 32000;

// Settings the Chat Completions API accepts that this module doesn't special-case; passed
// through as-is, the API validates their shape itself. `max_tokens`/`max_completion_tokens`
// are handled separately below (they need a default, not a blind pass-through).
const PASSTHROUGH_SETTINGS = [
  "max_completion_tokens",
  "temperature",
  "top_p",
  "frequency_penalty",
  "presence_penalty",
  "stop",
  "seed",
  "reasoning_effort",
  "parallel_tool_calls",
  "logprobs",
  "top_logprobs",
] as const;

/** Tool-call arguments: JSON parse with a `{_raw}` fallback so an unparseable call still
 * reaches the tool layer (which can hand the model back a tool-error) instead of vanishing. */
function parseToolArgs(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { _raw: raw };
  } catch {
    return { _raw: raw };
  }
}

/** Canonical content (string or OpenAI-shaped parts) collapsed to a plain string — for the
 * message roles (system/tool) whose Chat Completions param only accepts text content. */
function textOnly(content: ChatMessage["content"]): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .filter((part): part is Extract<ContentPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

/** A canonical content part is already structurally identical to OpenAI's — this stays an
 * explicit mapping (rather than a cast) so a future drift in either shape fails to compile
 * here instead of silently mismatching on the wire. */
function toOpenAIContentPart(part: ContentPart): OpenAI.ChatCompletionContentPart {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "image_url":
      return { type: "image_url", image_url: { url: part.image_url.url } };
    case "file":
      return { type: "file", file: { filename: part.file.filename, file_data: part.file.file_data } };
  }
}

function toUserContent(content: ChatMessage["content"]): string | OpenAI.ChatCompletionContentPart[] {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content.map(toOpenAIContentPart);
}

/** OpenAI wants `null`, not `""`, for an assistant turn that is tool-calls-only — some
 * compat servers reject an empty-string content alongside `tool_calls`. */
function assistantContent(content: ChatMessage["content"]): string | null {
  const text = textOnly(content);
  return text ? text : null;
}

function toOpenAIToolCall(call: ToolCallWire): OpenAI.ChatCompletionMessageFunctionToolCall {
  return { id: call.id, type: "function", function: { name: call.function.name, arguments: call.function.arguments } };
}

/** Canonical history -> `ChatCompletionMessageParam[]`. A near-passthrough reshape (see the
 * module doc comment) — the only real decisions are the null-vs-empty-string content rule
 * above and dropping `notice` rows defensively (Engine.outboundMessages() already filters
 * them before any provider ever sees them). */
function toOpenAIMessages(messages: ChatMessage[]): OpenAI.ChatCompletionMessageParam[] {
  const out: OpenAI.ChatCompletionMessageParam[] = [];
  for (const msg of messages) {
    if (msg.role === "system") {
      out.push({ role: "system", content: textOnly(msg.content) });
    } else if (msg.role === "user") {
      out.push({ role: "user", content: toUserContent(msg.content) });
    } else if (msg.role === "assistant") {
      const toolCalls = (msg.toolCalls ?? []).map(toOpenAIToolCall);
      out.push({
        role: "assistant",
        content: assistantContent(msg.content),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
    } else if (msg.role === "tool") {
      out.push({ role: "tool", tool_call_id: msg.toolCallId ?? "", content: textOnly(msg.content) });
    }
  }
  return out;
}

function toOpenAITool(schema: ToolSchema): OpenAI.ChatCompletionFunctionTool {
  return {
    type: "function",
    function: {
      name: schema.function.name,
      description: schema.function.description,
      parameters: schema.function.parameters,
    },
  };
}

// `ChatCompletionCreateParamsBase` (what these fields actually live on) isn't itself
// re-exported from the package root — only the streaming/non-streaming variants that extend
// it are — so borrow the shared fields off the non-streaming variant instead.
type ExtraChatParams = Partial<Omit<OpenAI.ChatCompletionCreateParamsNonStreaming, "stream">>;

function extraParams(settings: Record<string, unknown>): ExtraChatParams {
  const extra: ExtraChatParams = {};
  for (const key of PASSTHROUGH_SETTINGS) {
    if (settings[key] !== undefined) (extra as Record<string, unknown>)[key] = settings[key];
  }
  return extra;
}

function usageFrom(u: OpenAI.CompletionUsage | null | undefined): TokenUsage | undefined {
  if (!u) return undefined;
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  return { input: Math.max(u.prompt_tokens - cached, 0), output: u.completion_tokens, cacheRead: cached, cacheWrite: 0 };
}

/** Thinking text off a delta: `reasoning_content` (DeepSeek, GLM, Kimi, most compat vendors)
 * or `reasoning` (xAI, OpenRouter). Neither is in OpenAI's own wire shape, so the official
 * SDK types don't declare them — a compat vendor's extra field needs an explicit unknown-cast
 * read rather than a typed property access. */
function extraReasoningText(delta: unknown): string | undefined {
  const raw = delta as { reasoning_content?: unknown; reasoning?: unknown };
  const value = raw.reasoning_content ?? raw.reasoning;
  return typeof value === "string" && value ? value : undefined;
}

const DEFAULT_CAPABILITIES: ModelCapabilities = {
  tools: true,
  vision: false,
  pdf: false,
  parallelToolCalls: true,
  streaming: true,
};

// Known vision-capable prefixes on Chat Completions. Everything else (gpt-3.5-*, older
// completions-only models, most third-party compat models routed through this same client)
// falls back to the conservative default above rather than guessing.
const VISION_PREFIXES = ["gpt-4o", "gpt-4-turbo", "gpt-4.1", "gpt-5", "o3", "o4"];
// Reasoning-family models: no parallel tool calls, per OpenAI's own documented behavior.
const NO_PARALLEL_TOOLS_PREFIXES = ["o1", "o3", "o4", "gpt-5"];

export class OpenAIProvider implements ProviderClient {
  private readonly client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async complete(req: CompletionRequest): Promise<AssistantTurn> {
    // Drain the stream rather than duplicating the request-building/response-assembly logic
    // — every caller that only wants the final turn still gets exactly one round-trip.
    let turn: AssistantTurn | undefined;
    for await (const chunk of this.stream(req)) {
      if (chunk.turn) turn = chunk.turn;
    }
    return turn ?? { toolCalls: [] };
  }

  async *stream(req: CompletionRequest): AsyncIterable<StreamChunk> {
    const settings = req.settings ?? {};
    const hasMaxCompletionTokens = typeof settings.max_completion_tokens === "number";
    const maxTokens = typeof settings.max_tokens === "number"
      ? settings.max_tokens
      : hasMaxCompletionTokens
        ? undefined
        : DEFAULT_MAX_TOKENS;

    const params: OpenAI.ChatCompletionCreateParamsStreaming = {
      model: req.model,
      messages: toOpenAIMessages(req.messages),
      stream: true,
      stream_options: { include_usage: true },
      ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
      ...(req.tools?.length ? { tools: req.tools.map(toOpenAITool) } : {}),
      ...extraParams(settings),
    };

    const textParts: string[] = [];
    const reasoningParts: string[] = [];
    const toolAccum = new Map<number, { id: string; name: string; args: string }>();
    let finishReason: string | null | undefined;
    let usage: TokenUsage | undefined;

    const stream = await this.client.chat.completions.create(params, { signal: req.signal });
    for await (const chunk of stream) {
      const chunkUsage = usageFrom(chunk.usage);
      if (chunkUsage) usage = chunkUsage;

      const choice = chunk.choices[0];
      if (!choice) continue;
      const delta = choice.delta;
      if (delta) {
        const reasoning = extraReasoningText(delta);
        if (reasoning) {
          reasoningParts.push(reasoning);
          yield { reasoningDelta: reasoning };
        }
        if (delta.content) {
          textParts.push(delta.content);
          yield { textDelta: delta.content };
        }
        for (const tc of delta.tool_calls ?? []) {
          const acc = toolAccum.get(tc.index) ?? { id: "", name: "", args: "" };
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name = tc.function.name;
          if (tc.function?.arguments) acc.args += tc.function.arguments;
          toolAccum.set(tc.index, acc);
        }
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }

    const toolCalls: ToolCall[] = [...toolAccum.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, acc]) => ({ id: acc.id, name: acc.name, arguments: parseToolArgs(acc.args) }));

    yield {
      turn: {
        text: textParts.join("") || undefined,
        toolCalls,
        finishReason: finishReason ?? undefined,
        reasoning: reasoningParts.join("") || undefined,
        usage,
      },
    };
  }

  capabilities(model: string): ModelCapabilities {
    return {
      ...DEFAULT_CAPABILITIES,
      vision: VISION_PREFIXES.some((prefix) => model.startsWith(prefix)),
      parallelToolCalls: !NO_PARALLEL_TOOLS_PREFIXES.some((prefix) => model.startsWith(prefix)),
    };
  }
}
