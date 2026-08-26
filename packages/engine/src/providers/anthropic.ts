/**
 * Anthropic provider — native Claude Messages API.
 *
 * The engine's canonical history (`ChatMessage[]`, types.ts) is OpenAI-shaped, so this module
 * is mostly a pair of pure converters: canonical messages -> Anthropic `messages` + `system`,
 * and canonical `ToolSchema[]` -> Anthropic tool definitions. The Messages API differs from
 * chat.completions in ways the converters have to absorb:
 *
 * - `system` is a top-level string param, not a message in the array.
 * - Assistant tool calls are `tool_use` content blocks (`input` is an object, not a JSON
 *   string) — the wire `arguments` string on `ToolCallWire` has to be parsed.
 * - Tool results are `tool_result` blocks that must ALL land in the single next `user`
 *   message — N consecutive canonical `role: "tool"` rows (one per parallel call) collapse
 *   into one Anthropic user message here.
 * - `max_tokens` is required by the API (we default it rather than let the SDK reject the
 *   call).
 * - Extended thinking (opt-in via `req.settings.thinking`, never forced by this module):
 *   `thinking`/`redacted_thinking` blocks must be replayed verbatim (signature and all)
 *   ahead of the same turn's `tool_use` blocks on the next request. They ride the canonical
 *   assistant message as the `_anthropicThinking` sidecar (via `AssistantTurn.extras`) and are
 *   reattached in `assistantBlocks()`. Thinking text also lands on `AssistantTurn.reasoning`
 *   for display — it is never replayed as a plain-text turn.
 */
import Anthropic from "@anthropic-ai/sdk";
import type {
  AssistantTurn,
  ChatMessage,
  CompletionRequest,
  ContentPart,
  ModelCapabilities,
  StreamChunk,
  ToolCall,
  ToolSchema,
  TokenUsage,
} from "../types.js";
import type { ProviderClient } from "./base.js";

// Required by the Messages API; a ceiling; not a spend target. A coworker-style tool call
// that writes a whole file inline in its arguments needs real headroom — 16k truncates
// mid-write in the field, so this mirrors OpenWorker's floor.
const DEFAULT_MAX_TOKENS = 32000;

// Settings the Messages API actually accepts; everything else (e.g. frequency_penalty, an
// OpenAI-only knob a caller might pass through a shared settings blob) is silently dropped
// rather than sent and rejected.
const PASSTHROUGH_SETTINGS = ["temperature", "top_p", "top_k", "stop_sequences", "metadata", "thinking"] as const;

// Anthropic stop_reason -> the engine's OpenAI-shaped finishReason vocabulary (AssistantTurn
// doesn't mandate a specific vocabulary, but every other provider in this package speaks
// OpenAI's, so tool consumers of `finishReason` don't have to branch per provider).
const STOP_REASON_MAP: Record<string, string> = {
  end_turn: "stop",
  tool_use: "tool_calls",
  max_tokens: "length",
  stop_sequence: "stop",
  refusal: "stop",
  pause_turn: "stop",
};

const DATA_URL_RE = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/is;
const PDF_DATA_URL_RE = /^data:application\/pdf;base64,(.+)$/is;
const BASE64_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

type AnthropicContentBlock = Anthropic.ContentBlockParam;
type AssistantEntry = { role: "assistant"; content: AnthropicContentBlock[] };
type UserEntry = { role: "user"; content: AnthropicContentBlock[] };
type ConvertedEntry = AssistantEntry | UserEntry;

type ThinkingAccum =
  | { kind: "thinking"; thinking: string; signature: string }
  | { kind: "redacted_thinking"; data: string };

/** Tool-call arguments: JSON parse with a `{_raw}` fallback so an unparseable call still
 * reaches the tool layer (which can then hand the model back a tool-error) instead of
 * silently vanishing. */
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

/** An OpenAI-shaped `image_url` part -> an Anthropic image block. Attachments are always
 * data URLs; plain http(s) URLs map to a url source. Anything else (unsupported subtype,
 * malformed data) becomes a text notice instead of a thrown error — one bad attachment
 * shouldn't fail the whole turn. */
function imageBlock(url: string): Anthropic.ImageBlockParam | undefined {
  const match = DATA_URL_RE.exec(url);
  if (match) {
    const mediaType = match[1].toLowerCase();
    if (!BASE64_IMAGE_TYPES.has(mediaType)) return undefined;
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
        data: match[2],
      },
    };
  }
  if (/^https?:\/\//i.test(url)) {
    return { type: "image", source: { type: "url", url } };
  }
  return undefined;
}

/** An OpenAI-shaped `file` part (PDF data URL) -> an Anthropic document block. */
function documentBlock(part: Extract<ContentPart, { type: "file" }>): Anthropic.DocumentBlockParam | undefined {
  const match = PDF_DATA_URL_RE.exec(part.file.file_data ?? "");
  if (!match) return undefined;
  const block: Anthropic.DocumentBlockParam = {
    type: "document",
    source: { type: "base64", media_type: "application/pdf", data: match[1] },
  };
  if (part.file.filename) block.title = part.file.filename;
  return block;
}

/** Canonical user content (string or OpenAI-shaped parts) -> Anthropic content blocks. */
function userBlocks(content: ChatMessage["content"]): AnthropicContentBlock[] {
  if (content == null) return [];
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  const blocks: AnthropicContentBlock[] = [];
  for (const part of content) {
    if (part.type === "text") {
      if (part.text) blocks.push({ type: "text", text: part.text });
    } else if (part.type === "image_url") {
      blocks.push(imageBlock(part.image_url.url ?? "") ?? { type: "text", text: "[unsupported image attachment]" });
    } else if (part.type === "file") {
      blocks.push(documentBlock(part) ?? { type: "text", text: "[unsupported file attachment]" });
    }
  }
  return blocks;
}

/** Canonical assistant message -> Anthropic content blocks: replay any thinking blocks
 * carried on the `_anthropicThinking` sidecar verbatim first (required whenever this turn's
 * tool_use blocks are being answered), then text, then tool_use blocks. */
function assistantBlocks(msg: ChatMessage): AnthropicContentBlock[] {
  const blocks: AnthropicContentBlock[] = [];
  const thinking = msg._anthropicThinking;
  if (Array.isArray(thinking)) {
    for (const block of thinking) {
      if (!block || typeof block !== "object") continue;
      const record = block as Record<string, unknown>;
      if (record.type === "thinking") {
        blocks.push({
          type: "thinking",
          thinking: typeof record.thinking === "string" ? record.thinking : "",
          signature: typeof record.signature === "string" ? record.signature : "",
        });
      } else if (record.type === "redacted_thinking") {
        blocks.push({ type: "redacted_thinking", data: typeof record.data === "string" ? record.data : "" });
      }
    }
  }
  if (typeof msg.content === "string" && msg.content) {
    blocks.push({ type: "text", text: msg.content });
  }
  for (const call of msg.toolCalls ?? []) {
    blocks.push({ type: "tool_use", id: call.id, name: call.function.name, input: parseToolArgs(call.function.arguments) });
  }
  return blocks;
}

/** Canonical `role: "tool"` message -> the `tool_result` block, wrapped as a user message
 * (the shape Anthropic requires) so the fold step below can merge parallel results. */
function toolResultEntry(msg: ChatMessage): UserEntry {
  return {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: msg.toolCallId ?? "", content: String(msg.content ?? "") }],
  };
}

/** Canonical history -> (`system`, Anthropic `messages`). Leading `system` rows become the
 * `system` param; everything else converts in place, then consecutive same-role entries fold
 * into one message — this is what collapses a run of parallel tool results into the single
 * user message Anthropic requires. */
function convertMessages(messages: ChatMessage[]): { system?: string; messages: Anthropic.MessageParam[] } {
  const systemParts: string[] = [];
  let i = 0;
  while (i < messages.length && messages[i].role === "system") {
    const content = messages[i].content;
    if (typeof content === "string" && content) systemParts.push(content);
    i++;
  }

  const converted: ConvertedEntry[] = [];
  for (; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "system") {
      // Defensive: a stray mid-thread system message rides as marked user text (mid-thread
      // system messages aren't reliable across every provider — see engine.ts's
      // ContextProvider doc comment for the same rationale).
      const text = typeof msg.content === "string" ? msg.content : "";
      if (text) converted.push({ role: "user", content: [{ type: "text", text: `<system>\n${text}\n</system>` }] });
    } else if (msg.role === "user") {
      const blocks = userBlocks(msg.content);
      if (blocks.length) converted.push({ role: "user", content: blocks });
    } else if (msg.role === "assistant") {
      const blocks = assistantBlocks(msg);
      if (blocks.length) converted.push({ role: "assistant", content: blocks });
    } else if (msg.role === "tool") {
      converted.push(toolResultEntry(msg));
    }
    // "notice" rows never reach here — Engine.outboundMessages() already filters them out.
  }

  const folded: ConvertedEntry[] = [];
  for (const entry of converted) {
    const last = folded[folded.length - 1];
    if (last && last.role === entry.role) {
      last.content.push(...entry.content);
    } else {
      folded.push({ role: entry.role, content: [...entry.content] });
    }
  }

  if (folded.length === 0) {
    throw new Error("no convertible messages for the Anthropic Messages API");
  }
  if (folded[0].role !== "user") {
    folded.unshift({ role: "user", content: [{ type: "text", text: "(continued)" }] });
  }

  return { system: systemParts.length ? systemParts.join("\n\n") : undefined, messages: folded };
}

/** Canonical `ToolSchema` (OpenAI function-tool shape) -> an Anthropic tool definition.
 * Missing/typeless parameters become an empty object schema (Anthropic requires one). */
function toAnthropicTool(schema: ToolSchema): Anthropic.Tool {
  const params = schema.function.parameters;
  const hasType = !!params && typeof params === "object" && typeof (params as Record<string, unknown>).type === "string";
  const inputSchema = (hasType ? params : { type: "object", properties: {} }) as Anthropic.Tool.InputSchema;
  return {
    name: schema.function.name,
    ...(schema.function.description ? { description: schema.function.description } : {}),
    input_schema: inputSchema,
  };
}

/** Whitelisted settings, passed through as-is (the API validates their shape itself). */
function extraParams(settings: Record<string, unknown>): Partial<Anthropic.MessageStreamParams> {
  const extra: Partial<Anthropic.MessageStreamParams> = {};
  for (const key of PASSTHROUGH_SETTINGS) {
    if (settings[key] !== undefined) (extra as Record<string, unknown>)[key] = settings[key];
  }
  return extra;
}

function usageFrom(u: {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
}): TokenUsage {
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
  };
}

const DEFAULT_CAPABILITIES: ModelCapabilities = {
  tools: true,
  vision: true,
  pdf: true,
  parallelToolCalls: true,
  streaming: true,
};

// Legacy models predating tool use / vision entirely. Every current claude-3/4/5-family
// prefix gets the modern default below instead of an ever-growing enumerated list.
const LEGACY_PREFIXES = ["claude-instant", "claude-2", "claude-1"];

export class AnthropicProvider implements ProviderClient {
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
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
    const { system, messages } = convertMessages(req.messages);
    const settings = req.settings ?? {};
    const maxTokens = typeof settings.max_tokens === "number" ? settings.max_tokens : DEFAULT_MAX_TOKENS;

    const params: Anthropic.MessageStreamParams = {
      model: req.model,
      messages,
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
      ...(req.tools?.length ? { tools: req.tools.map(toAnthropicTool) } : {}),
      ...extraParams(settings),
    };

    const textParts: string[] = [];
    const toolAccum = new Map<number, { id: string; name: string; json: string }>();
    const thinkingAccum = new Map<number, ThinkingAccum>();
    let stopReason: string | undefined;
    let usage: TokenUsage | undefined;

    const events = this.client.messages.stream(params, { signal: req.signal });
    for await (const event of events) {
      if (event.type === "message_start") {
        // Prompt-side counts (input + cache split) ride the opening event.
        usage = usage ?? usageFrom(event.message.usage);
      } else if (event.type === "content_block_start") {
        const block = event.content_block;
        if (block.type === "tool_use") {
          toolAccum.set(event.index, { id: block.id, name: block.name, json: "" });
        } else if (block.type === "thinking") {
          thinkingAccum.set(event.index, { kind: "thinking", thinking: block.thinking ?? "", signature: block.signature ?? "" });
        } else if (block.type === "redacted_thinking") {
          thinkingAccum.set(event.index, { kind: "redacted_thinking", data: block.data ?? "" });
        }
      } else if (event.type === "content_block_delta") {
        const delta = event.delta;
        if (delta.type === "text_delta") {
          if (delta.text) {
            textParts.push(delta.text);
            yield { textDelta: delta.text };
          }
        } else if (delta.type === "input_json_delta") {
          const acc = toolAccum.get(event.index);
          if (acc) acc.json += delta.partial_json ?? "";
        } else if (delta.type === "thinking_delta") {
          const acc = thinkingAccum.get(event.index);
          if (acc && acc.kind === "thinking" && delta.thinking) {
            acc.thinking += delta.thinking;
            yield { reasoningDelta: delta.thinking };
          }
        } else if (delta.type === "signature_delta") {
          const acc = thinkingAccum.get(event.index);
          if (acc && acc.kind === "thinking") acc.signature += delta.signature ?? "";
        }
      } else if (event.type === "message_delta") {
        if (event.delta.stop_reason) stopReason = event.delta.stop_reason;
        // The cumulative output-token count is the only field message_delta reliably
        // carries mid-stream; input/cache counts stay whatever message_start reported.
        const out = event.usage.output_tokens;
        if (typeof out === "number" && out > 0) {
          usage = usage ? { ...usage, output: out } : { input: 0, output: out, cacheRead: 0, cacheWrite: 0 };
        }
      }
    }

    const toolCalls: ToolCall[] = [...toolAccum.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, acc]) => ({ id: acc.id, name: acc.name, arguments: parseToolArgs(acc.json) }));

    const thinkingBlocks = [...thinkingAccum.entries()].sort(([a], [b]) => a - b).map(([, acc]) => acc);
    const reasoning = thinkingBlocks
      .filter((b): b is Extract<ThinkingAccum, { kind: "thinking" }> => b.kind === "thinking")
      .map((b) => b.thinking)
      .join("");
    const extras: Record<string, unknown> = thinkingBlocks.length
      ? {
          _anthropicThinking: thinkingBlocks.map((b) =>
            b.kind === "thinking"
              ? { type: "thinking" as const, thinking: b.thinking, signature: b.signature }
              : { type: "redacted_thinking" as const, data: b.data },
          ),
        }
      : {};

    yield {
      turn: {
        text: textParts.join("") || undefined,
        toolCalls,
        finishReason: stopReason ? (STOP_REASON_MAP[stopReason] ?? stopReason) : undefined,
        reasoning: reasoning || undefined,
        extras,
        usage,
      },
    };
  }

  capabilities(model: string): ModelCapabilities {
    if (LEGACY_PREFIXES.some((prefix) => model.startsWith(prefix))) {
      return { tools: false, vision: false, pdf: false, parallelToolCalls: false, streaming: true };
    }
    return { ...DEFAULT_CAPABILITIES };
  }
}
