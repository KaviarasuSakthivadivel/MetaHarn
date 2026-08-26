/**
 * Shared contracts for @metaharn/engine.
 *
 * This file is the seam every parallel workstream builds against — tools, the permission
 * engine, the reviewer, MCP, automation, memory, etc. all import from here and from
 * `engine.ts`/`tools/registry.ts`/`providers/base.ts`, and NOTHING outside those four files
 * should need to change for a new workstream to land. If a workstream finds it needs to
 * change a shape here, that's a signal to flag it rather than silently diverge.
 *
 * Modeled on OpenWorker's coworker/{providers/base,permissions,engine}.py — ported to
 * TypeScript's native async iterables instead of the thread+queue bridge Python's blocking
 * SDKs required (see docs/research/openworker-integration.md §2 for why that's unnecessary
 * here: this whole engine runs on Electron main's single Node event loop already).
 */

// ---------------------------------------------------------------------------------------
// Canonical conversation history
// ---------------------------------------------------------------------------------------

export type ChatRole = "system" | "user" | "assistant" | "tool" | "notice";

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "file"; file: { filename: string; file_data: string } };

/** Wire shape of a tool call as it's persisted on an assistant message (OpenAI-shaped). */
export interface ToolCallWire {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/**
 * One canonical history entry. Deliberately loose (`[key: string]: unknown`) the way
 * OpenWorker's plain-dict messages are — sidecars (`source`, `_display`, `kind`, `ts`,
 * provider-private `extras`) ride alongside the fields every provider reads, and a provider
 * that doesn't understand a given sidecar must ignore it, never choke on it.
 */
export interface ChatMessage {
  role: ChatRole;
  content?: string | ContentPart[];
  toolCalls?: ToolCallWire[];
  toolCallId?: string;
  name?: string;
  ts?: number;
  [sidecar: string]: unknown;
}

// ---------------------------------------------------------------------------------------
// Providers & streaming (Tier 0 / Tier 7-providers)
// ---------------------------------------------------------------------------------------

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Normalized token counts for one model round-trip. `input` counts only fresh (uncached)
 * prompt tokens; cached prompt tokens split into cacheRead/cacheWrite. Providers that don't
 * report a cache split leave those at 0 — never guessed.
 */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Prompt-side total — what actually occupied the context window. */
export function contextTokens(u: TokenUsage): number {
  return u.input + u.cacheRead + u.cacheWrite;
}

/** One assistant response: free text and/or tool calls. */
export interface AssistantTurn {
  text?: string;
  toolCalls: ToolCall[];
  finishReason?: string;
  /** Display-only reasoning/thinking text — never replayed back to the provider as input. */
  reasoning?: string;
  /**
   * Provider-private sidecars persisted on the canonical assistant message (e.g. Gemini
   * thought signatures). Contract: the owning provider consumes its own key when converting
   * history; every other provider must ignore foreign keys.
   */
  extras?: Record<string, unknown>;
  usage?: TokenUsage;
  raw?: unknown;
}

export interface ModelCapabilities {
  tools: boolean;
  vision: boolean;
  pdf: boolean;
  parallelToolCalls: boolean;
  streaming: boolean;
}

/** One streamed piece: a text/reasoning delta, and/or (final) the full assembled turn. */
export interface StreamChunk {
  textDelta?: string;
  reasoningDelta?: string;
  turn?: AssistantTurn;
}

export interface ToolSchema {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface CompletionRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSchema[];
  settings?: Record<string, unknown>;
  /** Cancellation — every provider call must respect this; no thread bridge needed on Node. */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------------------
// Tools (Tier 1 workstreams register against this)
// ---------------------------------------------------------------------------------------

export type RiskClass = "read" | "egress" | "write_local" | "exec" | "external";

export interface ToolMetadata {
  category: string;
  riskLevel: "low" | "medium" | "high";
  /** Declared risk class — drives permission gating. Defaults to "read" if omitted. */
  risk?: RiskClass;
  requiresApproval?: boolean;
  capabilities?: string[];
}

export interface ToolExecutionContext {
  toolCallId: string;
  signal: AbortSignal;
}

export interface ToolDefinition {
  name: string;
  schema: ToolSchema;
  metadata: ToolMetadata;
  execute: (args: Record<string, unknown>, ctx: ToolExecutionContext) => Promise<unknown>;
}

// ---------------------------------------------------------------------------------------
// Permissions (Tier 2 workstreams implement PermissionEvaluator against this)
// ---------------------------------------------------------------------------------------

export interface PermissionDecision {
  allowed: boolean;
  reason: string;
  /** True → the engine should surface a PERMISSION_REQUIRED event and await approval. */
  needsUser: boolean;
  /**
   * True → this ask is reserved for a human: the reviewer must not be consulted and cannot
   * clear it (e.g. an unlocatable write path, or a file that executes later).
   */
  humanOnly: boolean;
  /** Set when a standing rule cleared the call, so the caller can audit/display which one. */
  rule?: string;
}

export interface PermissionEvaluator {
  evaluate(
    toolName: string,
    args: Record<string, unknown>,
    metadata: ToolMetadata,
  ): PermissionDecision;
}

export type ApprovalOutcome =
  | "once"
  | "always_tool"
  | "always_command"
  | "always_domain"
  | "readonly_session"
  | "deny";

export interface PermissionRequest {
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  reason: string;
}

export type Approver = (req: PermissionRequest) => Promise<ApprovalOutcome>;

// ---------------------------------------------------------------------------------------
// Auto-Approve reviewer (Tier 4 workstream implements Reviewer against this)
// ---------------------------------------------------------------------------------------

export type ReviewVerdict = "allow" | "deny" | "unsure";

export interface ReviewResult {
  verdict: ReviewVerdict;
  reason: string;
  usage?: TokenUsage;
  /** True when this verdict came from the machinery failing (timeout/parse), not judgment. */
  error?: boolean;
}

export interface ReviewInput {
  request: string; // the user's original ask, for scope-judging
  toolName: string;
  arguments: Record<string, unknown>;
  /** Fixed-vocabulary provenance note, e.g. "path.py was written by the agent 2 steps ago". */
  provenance?: string;
}

export interface Reviewer {
  review(input: ReviewInput): Promise<ReviewResult>;
}

// ---------------------------------------------------------------------------------------
// Engine events — one per step of the turn loop (see Fig. 1, "Owning the Loop" §4)
// ---------------------------------------------------------------------------------------

export type TurnEndStatus = "completed" | "interrupted" | "error" | "max_iterations_exceeded";

export type EngineEvent =
  | { type: "turn_start"; input: string }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "assistant_message"; text: string; reasoning?: string }
  | { type: "tool_start"; toolCallId: string; name: string; arguments: Record<string, unknown> }
  | {
      type: "permission_required";
      toolCallId: string;
      name: string;
      arguments: Record<string, unknown>;
      reason: string;
    }
  | { type: "tool_end"; toolCallId: string; name: string; result: unknown; error?: string }
  | { type: "turn_end"; status: TurnEndStatus; iterations: number }
  | { type: "error"; error: string };

// ---------------------------------------------------------------------------------------
// Optional cross-cutting hooks — every one is an injected seam a later workstream fills in.
// The engine works with none of them attached; each just narrows behavior when present.
// ---------------------------------------------------------------------------------------

/** Tier 5 (compaction) plugs in here: called before each model round-trip. */
export type CompactionHook = (messages: ChatMessage[]) => Promise<ChatMessage[]> | ChatMessage[];

/** Ephemeral per-turn context (live directory list, plan-mode reminder, …) appended to the
 * latest user message at send time only — never persisted. Mirrors OpenWorker's
 * `context_provider` (engine.py) since mid-thread system messages aren't reliable across
 * providers. */
export type ContextProvider = () => string;
