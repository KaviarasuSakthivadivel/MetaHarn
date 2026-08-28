/**
 * Gemini provider — native Google GenAI API (`@google/genai`).
 *
 * Ported from OpenWorker's own `coworker/providers/gemini_provider.py` (same conversion
 * rules, same edge cases — this module mirrors it function-for-function rather than
 * reinventing the mapping). Like the Anthropic/OpenAI providers, this is mostly a pair of
 * pure converters between the engine's canonical OpenAI-shaped history and Gemini's
 * `generateContent` request/response shape. The differences the converters have to absorb:
 *
 * - The system prompt is `systemInstruction` inside the request config, not a message role.
 * - Roles are `user`/`model`; tool RESULTS ride as `functionResponse` parts in a `user`
 *   message — Gemini has no separate "tool" role on the wire.
 * - Function calls carry no id on the wire. The engine still needs a stable per-call id (for
 *   `tool_call_id` round-tripping), so this module synthesizes `call_<n>` ids when building
 *   the canonical `AssistantTurn`, then rebuilds an id→name map from the SAME history being
 *   converted on the next call to match each `tool` message's `toolCallId` back to the
 *   function name Gemini actually needs.
 * - Tool parameter schemas are an OpenAPI 3.0 subset — `additionalProperties`, `$schema`, and
 *   other JSON-Schema-only keys are rejected outright, and a JSON-Schema union `type` array
 *   (e.g. `["string", "null"]`, common on vendor MCP tool schemas) must become `nullable` +
 *   a single `type`, or `anyOf` for a real union — `_sanitizeSchema` strips/reshapes exactly
 *   the key set OpenWorker's own `_SCHEMA_KEYS`/`_sanitize_schema` allow through.
 * - Gemini 3's thought signatures: response parts can carry a `thoughtSignature` that MUST be
 *   echoed back on the same parts in later requests, or multi-turn tool loops break. They
 *   ride the canonical assistant message as the `_gemini` sidecar (via `AssistantTurn.extras`,
 *   base64 strings) and are reattached in `convertMessages()`. Parts flagged `thought` are
 *   reasoning summaries — their text goes to `AssistantTurn.reasoning`, never the answer.
 */
import { GoogleGenAI, FinishReason as GeminiFinishReason, type Content, type Part, type Tool as GeminiTool } from "@google/genai";
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

// GenerateContentConfig keys passed through as-is; everything else (e.g. an OpenAI-only knob
// a caller might send through a shared settings blob) is dropped rather than sent and rejected.
const SETTINGS_WHITELIST = ["temperature", "top_p", "top_k", "max_output_tokens", "stop_sequences"] as const;

// The OpenAPI-subset schema keys Gemini function declarations accept — everything else
// (additionalProperties, $schema, …) 400s the request.
const SCHEMA_KEYS = new Set([
  "type",
  "format",
  "description",
  "nullable",
  "enum",
  "items",
  "properties",
  "required",
  "anyOf",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "pattern",
  "example",
  "default",
  "title",
]);

const DATA_URL_RE = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/is;
const PDF_DATA_URL_RE = /^data:application\/pdf;base64,(.+)$/is;

function imagePart(url: string): Part | undefined {
  const m = DATA_URL_RE.exec(url || "");
  return m ? { inlineData: { mimeType: m[1].toLowerCase(), data: m[2] } } : undefined;
}

function pdfPart(part: Extract<ContentPart, { type: "file" }>): Part | undefined {
  const m = PDF_DATA_URL_RE.exec(part.file.file_data || "");
  return m ? { inlineData: { mimeType: "application/pdf", data: m[1] } } : undefined;
}

/** User content (string or canonical parts list) → Gemini parts. */
function userParts(content: ChatMessage["content"]): Part[] {
  if (typeof content === "string") return content ? [{ text: content }] : [];
  const parts: Part[] = [];
  for (const part of content ?? []) {
    if (part.type === "text") {
      if (part.text) parts.push({ text: part.text });
    } else if (part.type === "image_url") {
      parts.push(imagePart(part.image_url.url) ?? { text: "[unsupported image attachment]" });
    } else if (part.type === "file") {
      parts.push(pdfPart(part) ?? { text: "[unsupported file attachment]" });
    }
  }
  return parts;
}

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { _raw: raw };
  } catch {
    return { _raw: raw };
  }
}

/** A tool result's canonical content → the JSON object Gemini requires as a function response. */
function resultPayload(content: ChatMessage["content"]): Record<string, unknown> {
  const text = typeof content === "string" ? content : "";
  if (!text) return { result: "" };
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { result: parsed };
  } catch {
    return { result: text };
  }
}

interface GeminiSidecar {
  text_sig?: string;
  call_sigs?: (string | undefined)[];
}

/** Canonical history → (systemInstruction, Gemini `contents`). Tool-result runs and adjacent
 * same-role turns fold into one Content entry — Gemini rejects non-alternating roles, same as
 * OpenWorker's own converter folds them. */
function convertMessages(messages: ChatMessage[]): { system?: string; contents: Content[] } {
  const systemParts: string[] = [];
  let i = 0;
  while (i < messages.length && messages[i].role === "system") {
    const content = messages[i].content;
    if (typeof content === "string" && content) systemParts.push(content);
    i++;
  }

  const callNames = new Map<string, string>();
  const converted: Content[] = [];
  for (const message of messages.slice(i)) {
    if (message.role === "system") {
      const text = typeof message.content === "string" ? message.content : "";
      if (text) converted.push({ role: "user", parts: [{ text: `<system>\n${text}\n</system>` }] });
    } else if (message.role === "user") {
      const parts = userParts(message.content);
      if (parts.length) converted.push({ role: "user", parts });
    } else if (message.role === "assistant") {
      const sidecar = (message._gemini as GeminiSidecar | undefined) ?? {};
      const callSigs = sidecar.call_sigs ?? [];
      const parts: Part[] = [];
      const text = typeof message.content === "string" ? message.content : "";
      if (text) {
        const part: Part = { text };
        if (sidecar.text_sig) part.thoughtSignature = sidecar.text_sig;
        parts.push(part);
      }
      (message.toolCalls ?? []).forEach((call, idx) => {
        const name = call.function.name;
        callNames.set(call.id, name);
        const part: Part = { functionCall: { name, args: parseArgs(call.function.arguments) } };
        if (callSigs[idx]) part.thoughtSignature = callSigs[idx];
        parts.push(part);
      });
      if (parts.length) converted.push({ role: "model", parts });
    } else if (message.role === "tool") {
      const callId = message.toolCallId ?? "";
      converted.push({
        role: "user",
        parts: [{ functionResponse: { name: callNames.get(callId) ?? callId, response: resultPayload(message.content) } }],
      });
    }
  }

  const folded: Content[] = [];
  for (const message of converted) {
    const last = folded[folded.length - 1];
    if (last && last.role === message.role) last.parts = [...(last.parts ?? []), ...(message.parts ?? [])];
    else folded.push({ ...message, parts: [...(message.parts ?? [])] });
  }
  if (!folded.length) throw new Error("no convertible messages for the Gemini API");
  if (folded[0].role !== "user") folded.unshift({ role: "user", parts: [{ text: "(continued)" }] });

  return { system: systemParts.join("\n\n") || undefined, contents: folded };
}

/** Recursively strips JSON Schema keys Gemini's OpenAPI subset rejects, and coerces a
 * list-valued `type` (JSON Schema union) into shapes the API accepts: `null` joins as
 * `nullable`, a single remaining type stays `type`, several become `anyOf`. */
function sanitizeSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const input = schema as Record<string, unknown>;
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!SCHEMA_KEYS.has(key)) continue;
    if (key === "properties" && value && typeof value === "object") {
      cleaned.properties = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, sanitizeSchema(v)]));
    } else if (key === "items") {
      cleaned.items = sanitizeSchema(value);
    } else if (key === "anyOf" && Array.isArray(value)) {
      cleaned.anyOf = value.map(sanitizeSchema);
    } else if (key === "type" && Array.isArray(value)) {
      const types = value.filter((t) => t !== "null");
      if (types.length !== value.length) cleaned.nullable = true;
      if (types.length === 1) cleaned.type = types[0];
      else if (types.length) cleaned.anyOf = types.map((t) => ({ type: t }));
    } else {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

function convertTools(tools: ToolSchema[] | undefined): GeminiTool[] {
  const declarations = (tools ?? []).map((tool) => {
    const fn = tool.function;
    const entry: Record<string, unknown> = { name: fn.name };
    if (fn.description) entry.description = fn.description;
    // Parameter-less functions omit `parameters` entirely — Gemini rejects an empty object.
    if (fn.parameters && typeof fn.parameters === "object" && "properties" in fn.parameters) {
      entry.parameters = sanitizeSchema(fn.parameters);
    }
    return entry;
  });
  return declarations.length ? [{ functionDeclarations: declarations }] : [];
}

function sigStr(part: Part): string | undefined {
  return typeof part.thoughtSignature === "string" && part.thoughtSignature ? part.thoughtSignature : undefined;
}

function signatureExtras(textSig: string | undefined, callSigs: (string | undefined)[]): Record<string, unknown> {
  if (!textSig && !callSigs.some(Boolean)) return {};
  return { _gemini: { text_sig: textSig, call_sigs: callSigs } };
}

interface Parsed {
  texts: string[];
  thoughts: string[];
  calls: ToolCall[];
  finish?: string;
  textSig?: string;
  callSigs: (string | undefined)[];
}

/** Pulls answer text, thought summaries, function calls (ids synthesized by the caller), the
 * finish reason, and thought signatures out of one response or streamed chunk. Parts flagged
 * `thought` are reasoning — their signature is kept, their text never joins the answer. */
function parseCandidate(response: { candidates?: Array<{ content?: Content; finishReason?: GeminiFinishReason }> }): Parsed {
  const out: Parsed = { texts: [], thoughts: [], calls: [], callSigs: [] };
  const candidate = response.candidates?.[0];
  if (!candidate) return out;
  for (const part of candidate.content?.parts ?? []) {
    const sig = sigStr(part);
    if (part.functionCall) {
      out.calls.push({ id: "", name: part.functionCall.name ?? "", arguments: part.functionCall.args ?? {} });
      out.callSigs.push(sig);
      continue;
    }
    if (sig) out.textSig = sig;
    if (part.thought) {
      if (part.text) out.thoughts.push(part.text);
      continue;
    }
    if (part.text) out.texts.push(part.text);
  }
  if (candidate.finishReason) out.finish = candidate.finishReason;
  return out;
}

// Gemini finishReason → the engine's OpenAI-shaped finishReason vocabulary. STOP maps to
// "tool_calls" instead when the turn contains function calls — Gemini has no distinct reason.
const FINISH_REASON_MAP: Record<string, string> = {
  STOP: "stop",
  MAX_TOKENS: "length",
  SAFETY: "stop",
  RECITATION: "stop",
  MALFORMED_FUNCTION_CALL: "stop",
};

function mapFinish(finish: string | undefined, hasCalls: boolean): string | undefined {
  if (hasCalls) return "tool_calls";
  if (!finish) return undefined;
  return FINISH_REASON_MAP[finish] ?? finish.toLowerCase();
}

/** `usageMetadata` → normalized counts. `promptTokenCount` INCLUDES the cached share;
 * thinking tokens are billed as output, so they fold into `output`. */
function usageFrom(meta: { promptTokenCount?: number; cachedContentTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number } | undefined): TokenUsage | undefined {
  if (!meta) return undefined;
  const prompt = meta.promptTokenCount ?? 0;
  const cached = meta.cachedContentTokenCount ?? 0;
  return {
    input: Math.max(prompt - cached, 0),
    output: (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0),
    cacheRead: cached,
    cacheWrite: 0,
  };
}

const CAPABILITIES: ModelCapabilities = { tools: true, vision: true, pdf: true, parallelToolCalls: true, streaming: true };

export interface GeminiProviderOptions {
  apiKey: string;
}

export class GeminiProvider implements ProviderClient {
  private readonly client: GoogleGenAI;

  constructor(opts: GeminiProviderOptions) {
    this.client = new GoogleGenAI({ apiKey: opts.apiKey });
  }

  private requestParams(req: CompletionRequest) {
    const { system, contents } = convertMessages(req.messages);
    const settings = req.settings ?? {};
    const config: Record<string, unknown> = {};
    for (const key of SETTINGS_WHITELIST) if (settings[key] !== undefined) config[key] = settings[key];
    if (typeof settings.max_tokens === "number" && config.max_output_tokens === undefined) config.max_output_tokens = settings.max_tokens;
    if (settings.stop !== undefined && config.stop_sequences === undefined) {
      config.stop_sequences = Array.isArray(settings.stop) ? settings.stop : [settings.stop];
    }
    // Thinking models (2.5+/3.x — every curated Gemini id) think by default; ask for the
    // thought SUMMARIES too so the transcript can show them (parse side keeps them out of
    // the answer text).
    if (req.model.startsWith("gemini-")) config.thinkingConfig = { includeThoughts: true };
    if (system) config.systemInstruction = system;
    const tools = convertTools(req.tools);
    if (tools.length) config.tools = tools;
    config.automaticFunctionCalling = { disable: true };
    return { model: req.model, contents, config };
  }

  async complete(req: CompletionRequest): Promise<AssistantTurn> {
    let turn: AssistantTurn | undefined;
    for await (const chunk of this.stream(req)) {
      if (chunk.turn) turn = chunk.turn;
    }
    return turn ?? { toolCalls: [] };
  }

  async *stream(req: CompletionRequest): AsyncIterable<StreamChunk> {
    const params = this.requestParams(req);
    const textParts: string[] = [];
    const thoughtParts: string[] = [];
    const calls: ToolCall[] = [];
    const callSigs: (string | undefined)[] = [];
    let finish: string | undefined;
    let textSig: string | undefined;
    let usage: TokenUsage | undefined;

    // Unlike Anthropic/OpenAI, function-call parts arrive whole (args are a complete object
    // per part) — no incremental-JSON accumulation, just collect parts across chunks.
    const stream = await this.client.models.generateContentStream(params as Parameters<GoogleGenAI["models"]["generateContentStream"]>[0]);
    for await (const chunk of stream) {
      const chunkUsage = usageFrom(chunk.usageMetadata);
      if (chunkUsage) usage = chunkUsage;
      const parsed = parseCandidate(chunk);
      for (const thought of parsed.thoughts) {
        thoughtParts.push(thought);
        yield { reasoningDelta: thought };
      }
      for (const text of parsed.texts) {
        textParts.push(text);
        yield { textDelta: text };
      }
      calls.push(...parsed.calls);
      callSigs.push(...parsed.callSigs);
      if (parsed.textSig) textSig = parsed.textSig;
      if (parsed.finish) finish = parsed.finish;
    }

    const toolCalls: ToolCall[] = calls.map((c, i) => ({ id: `call_${i}`, name: c.name, arguments: c.arguments }));

    yield {
      turn: {
        text: textParts.join("") || undefined,
        toolCalls,
        finishReason: mapFinish(finish, toolCalls.length > 0),
        reasoning: thoughtParts.join("") || undefined,
        extras: signatureExtras(textSig, callSigs),
        usage,
      },
    };
  }

  capabilities(): ModelCapabilities {
    return { ...CAPABILITIES };
  }
}
