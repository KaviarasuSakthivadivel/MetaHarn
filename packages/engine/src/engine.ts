/**
 * Engine — the owned agent loop. TypeScript sibling of OpenWorker's coworker/engine.py
 * TurnEngine (see docs/research/openworker-integration.md §4 and the "Owning the Loop"
 * artifact's Fig. 1 for the full design rationale).
 *
 * One user turn spans however many model<->tool round-trips it takes, however many of
 * those need a human, until the model stops requesting tools or the turn is interrupted.
 * `run()` is an async generator of EngineEvents, not a promise that resolves once — every
 * later feature (interrupts, steering, compaction, durable resume) is a branch inside the
 * same loop, never a rewrite of it. Constructor takes zero UI knowledge: every human-facing
 * interaction (approvals) is an injected callback.
 *
 * Deliberately NOT using a thread+queue bridge the way the Python original needs to:
 * MetaHarn's Electron main process is already one Node event loop, and every mainstream
 * provider SDK streams via a native async iterable — a blocking foreign-thread hand-off has
 * no equivalent problem to solve here. See docs/research/openworker-integration.md §2.
 */
import type {
  ApprovalOutcome,
  Approver,
  AssistantTurn,
  ChatMessage,
  CompactionHook,
  ContextProvider,
  EngineEvent,
  PermissionEvaluator,
  Reviewer,
  ToolCall,
  ToolCallWire,
} from "./types.js";
import type { ProviderClient } from "./providers/base.js";
import type { ToolRegistry } from "./tools/registry.js";

/** Denials in a row (within one turn) after which the reviewer stops being consulted and
 * every remaining ask that turn goes straight to the human. Mirrors OpenWorker's
 * §8.4 retry guard (5 — chosen there after a 2-cumulative trip proved too easy to hit on a
 * long, legitimate agentic turn). */
const REVIEWER_TRIP = 5;

export interface EngineOptions {
  provider: ProviderClient;
  registry: ToolRegistry;
  permissions: PermissionEvaluator;
  model: string;
  instructions?: string;
  approver?: Approver;
  reviewer?: Reviewer;
  maxIterations?: number;
  modelSettings?: Record<string, unknown>;
  messages?: ChatMessage[];
  compaction?: CompactionHook;
  contextProvider?: ContextProvider;
  auditSink?: (event: Record<string, unknown>) => void;
}

export class Engine {
  readonly messages: ChatMessage[];
  private readonly provider: ProviderClient;
  private readonly registry: ToolRegistry;
  private readonly permissions: PermissionEvaluator;
  private readonly approver?: Approver;
  private readonly reviewer?: Reviewer;
  private readonly maxIterations: number;
  private readonly modelSettings: Record<string, unknown>;
  private readonly compaction?: CompactionHook;
  private readonly contextProvider?: ContextProvider;
  private readonly auditSink?: (event: Record<string, unknown>) => void;

  model: string;
  private cancelled = false;
  private abortController: AbortController | null = null;
  private readonly steeringQueue: string[] = [];
  private reviewerDenials = 0;

  constructor(opts: EngineOptions) {
    this.provider = opts.provider;
    this.registry = opts.registry;
    this.permissions = opts.permissions;
    this.model = opts.model;
    this.approver = opts.approver;
    this.reviewer = opts.reviewer;
    this.maxIterations = opts.maxIterations ?? 12;
    this.modelSettings = opts.modelSettings ?? {};
    this.compaction = opts.compaction;
    this.contextProvider = opts.contextProvider;
    this.auditSink = opts.auditSink;

    this.messages = [...(opts.messages ?? [])];
    if (opts.instructions && this.messages[0]?.role !== "system") {
      this.messages.unshift({ role: "system", content: opts.instructions });
    }
  }

  // -- external controls --------------------------------------------------------------

  /** Stop the turn as soon as possible from ANY state — mid-stream, mid-tool-wait, or
   * between iterations. Every pending tool call still gets a tool-error result so history
   * never carries an orphaned call. */
  requestInterrupt(): void {
    this.cancelled = true;
    this.abortController?.abort();
  }

  /** Inject a message while the agent is still working; applied before the next model call
   * instead of waiting for the current turn to finish. */
  queueSteering(text: string): void {
    this.steeringQueue.push(text);
  }

  /** Rebind the model mid-conversation. History is canonical and provider-agnostic, so this
   * is just the field write. */
  switchModel(model: string): void {
    this.model = model;
  }

  // -- main loop ------------------------------------------------------------------------

  async *run(userInput: string): AsyncGenerator<EngineEvent> {
    this.messages.push({ role: "user", content: userInput, ts: Date.now() });
    this.cancelled = false;
    this.reviewerDenials = 0;
    yield { type: "turn_start", input: userInput };
    yield* this.loop();
  }

  /** Re-run after a provider error — no new user message; the failed turn's input is
   * already the tail of history. */
  async *retry(): AsyncGenerator<EngineEvent> {
    const tail = this.messages[this.messages.length - 1];
    if (!tail || tail.role !== "notice" || tail.kind !== "error") return;
    this.cancelled = false;
    yield { type: "turn_start", input: "" };
    yield* this.loop();
  }

  /** Continue a turn suspended on an unanswered tool call (durable resume after a restart).
   * Re-processes the trailing assistant message's unanswered calls, then runs the loop to
   * finish the turn. */
  async *resume(): AsyncGenerator<EngineEvent> {
    const pending = this.unansweredTrailingToolCalls();
    if (pending.length === 0) return;
    this.cancelled = false;
    yield { type: "turn_start", input: "(resumed)" };
    yield* this.handleToolCalls(pending);
    if (!this.cancelled) yield* this.loop();
  }

  private unansweredTrailingToolCalls(): ToolCall[] {
    const answered = new Set(
      this.messages.filter((m) => m.role === "tool").map((m) => m.toolCallId),
    );
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i];
      if (msg.role === "user") return [];
      if (msg.role === "assistant" && msg.toolCalls?.length) {
        return msg.toolCalls
          .filter((tc) => !answered.has(tc.id))
          .map((tc) => ({
            id: tc.id,
            name: tc.function.name,
            arguments: safeParseArgs(tc.function.arguments),
          }));
      }
    }
    return [];
  }

  private async *loop(): AsyncGenerator<EngineEvent> {
    let iterations = 0;
    while (true) {
      if (iterations >= this.maxIterations) {
        yield { type: "turn_end", status: "max_iterations_exceeded", iterations };
        return;
      }
      iterations++;

      if (this.compaction) {
        const compacted = await this.compaction(this.messages);
        this.messages.length = 0;
        this.messages.push(...compacted);
      }

      this.abortController = new AbortController();
      let turn: AssistantTurn;
      const deltas: EngineEvent[] = [];
      try {
        turn = await this.streamTurn(deltas);
      } catch (err) {
        yield { type: "error", error: describeError(err) };
        this.appendNotice("error", describeError(err));
        yield { type: "turn_end", status: "error", iterations };
        return;
      }
      for (const delta of deltas) yield delta;

      if (this.cancelled) {
        yield { type: "turn_end", status: "interrupted", iterations };
        return;
      }

      this.messages.push({
        role: "assistant",
        content: turn.text ?? "",
        toolCalls: turn.toolCalls.length ? toWireCalls(turn.toolCalls) : undefined,
        ...(turn.reasoning ? { reasoning: turn.reasoning } : {}),
        ...(turn.extras ?? {}),
      });
      yield { type: "assistant_message", text: turn.text ?? "", reasoning: turn.reasoning };

      if (turn.toolCalls.length === 0) {
        if (this.steeringQueue.length > 0) {
          const next = this.steeringQueue.shift()!;
          this.messages.push({ role: "user", content: next, ts: Date.now() });
          continue;
        }
        yield { type: "turn_end", status: "completed", iterations };
        return;
      }

      yield* this.handleToolCalls(turn.toolCalls);
      if (this.cancelled) {
        yield { type: "turn_end", status: "interrupted", iterations };
        return;
      }
    }
  }

  /** Bridge the provider's async-iterable stream into engine events, collecting the final
   * AssistantTurn. No thread/queue bridge needed — see the module docstring. */
  private async streamTurn(sink: EngineEvent[]): Promise<AssistantTurn> {
    const outbound = this.outboundMessages();
    let turn: AssistantTurn | undefined;
    for await (const chunk of this.provider.stream({
      model: this.model,
      messages: outbound,
      tools: this.registry.schemas(),
      settings: this.modelSettings,
      signal: this.abortController!.signal,
    })) {
      if (this.cancelled) break;
      if (chunk.textDelta) sink.push({ type: "text_delta", text: chunk.textDelta });
      if (chunk.reasoningDelta) sink.push({ type: "thinking_delta", text: chunk.reasoningDelta });
      if (chunk.turn) turn = chunk.turn;
    }
    return turn ?? { toolCalls: [] };
  }

  /** What actually gets sent to the provider: canonical history, minus `notice` rows (they
   * never leave this process), plus one ephemeral `<system-context>` suffix on the latest
   * user message (mirrors OpenWorker's context_provider — mid-thread system messages aren't
   * reliable across every provider). */
  private outboundMessages(): ChatMessage[] {
    const view = this.messages.filter((m) => m.role !== "notice");
    const ctx = this.contextProvider?.();
    if (!ctx) return view;
    for (let i = view.length - 1; i >= 0; i--) {
      if (view[i].role !== "user") continue;
      const msg = { ...view[i] };
      const suffix = `\n\n<system-context>\n${ctx}\n</system-context>`;
      msg.content = typeof msg.content === "string" ? msg.content + suffix : msg.content;
      return [...view.slice(0, i), msg, ...view.slice(i + 1)];
    }
    return view;
  }

  // -- tool-call handling: authorize (sequential), execute cleared calls (mixed-risk) ----

  private async *handleToolCalls(calls: ToolCall[]): AsyncGenerator<EngineEvent> {
    const cleared: ToolCall[] = [];

    for (const call of calls) {
      if (this.cancelled) return;
      const tool = this.registry.get(call.name);
      if (!tool) {
        this.appendToolError(call, `unknown tool: ${call.name}`);
        continue;
      }

      const decision = this.permissions.evaluate(call.name, call.arguments, tool.metadata);
      if (decision.allowed) {
        cleared.push(call);
        this.audit({ stage: "authorized", tool: call.name, status: "allowed", reason: decision.reason, rule: decision.rule });
        continue;
      }

      if (!decision.needsUser) {
        this.appendToolError(call, decision.reason);
        this.audit({ stage: "authorized", tool: call.name, status: "denied", reason: decision.reason });
        continue;
      }

      // Auto-Approve reviewer: consulted only on needsUser, non-human-only decisions, and
      // only until REVIEWER_TRIP denials in a row this turn (§8.4 retry guard).
      if (!decision.humanOnly && this.reviewer && this.reviewerDenials < REVIEWER_TRIP) {
        const verdict = await this.reviewer.review({
          request: this.lastUserText(),
          toolName: call.name,
          arguments: call.arguments,
        });
        this.audit({ stage: "reviewer", tool: call.name, status: verdict.verdict, reason: verdict.reason });
        if (verdict.verdict === "allow") {
          this.reviewerDenials = 0;
          cleared.push(call);
          continue;
        }
        if (verdict.verdict === "deny") {
          this.reviewerDenials++;
          this.appendToolError(call, "blocked by the safety reviewer");
          continue;
        }
        // "unsure" falls through to the human below.
      }

      yield {
        type: "permission_required",
        toolCallId: call.id,
        name: call.name,
        arguments: call.arguments,
        reason: decision.reason,
      };
      const outcome: ApprovalOutcome = this.approver ? await this.approver({
        toolCallId: call.id,
        toolName: call.name,
        arguments: call.arguments,
        reason: decision.reason,
      }) : "deny";
      this.audit({ stage: "approval_resolved", tool: call.name, status: outcome });
      if (outcome === "deny") {
        this.appendToolError(call, "denied by user");
        continue;
      }
      cleared.push(call);
      if (this.cancelled) return;
    }

    if (cleared.length === 0) return;

    // Mixed-risk concurrency: reads/searches run via Promise.all, everything else (writes,
    // shell, egress, external) stays strictly serial.
    const reads = cleared.filter((c) => (this.registry.metadata(c.name)?.risk ?? "read") === "read");
    const rest = cleared.filter((c) => !reads.includes(c));

    const readResults = await Promise.all(reads.map((c) => this.executeOne(c)));
    for (const events of readResults) for (const e of events) yield e;

    for (const call of rest) {
      if (this.cancelled) return;
      for (const e of await this.executeOne(call)) yield e;
    }
  }

  private async executeOne(call: ToolCall): Promise<EngineEvent[]> {
    const events: EngineEvent[] = [
      { type: "tool_start", toolCallId: call.id, name: call.name, arguments: call.arguments },
    ];
    const tool = this.registry.get(call.name)!;
    const ctx = { toolCallId: call.id, signal: this.abortController?.signal ?? new AbortController().signal };
    try {
      const result = await tool.execute(call.arguments, ctx);
      this.messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: stringifyResult(result) });
      events.push({ type: "tool_end", toolCallId: call.id, name: call.name, result });
      this.audit({ stage: "executed", tool: call.name, status: "ok" });
    } catch (err) {
      const message = describeError(err);
      this.messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: JSON.stringify({ error: message }) });
      events.push({ type: "tool_end", toolCallId: call.id, name: call.name, result: undefined, error: message });
      this.audit({ stage: "executed", tool: call.name, status: "error", reason: message });
    }
    return events;
  }

  private appendToolError(call: ToolCall, reason: string): void {
    this.messages.push({
      role: "tool",
      toolCallId: call.id,
      name: call.name,
      content: JSON.stringify({ error: reason }),
    });
  }

  private appendNotice(kind: string, text?: string): void {
    this.messages.push({ role: "notice", kind, text, ts: Date.now() });
  }

  private lastUserText(): string {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i];
      if (msg.role === "user") return typeof msg.content === "string" ? msg.content : "";
    }
    return "";
  }

  private audit(event: Record<string, unknown>): void {
    this.auditSink?.(event);
  }
}

function toWireCalls(calls: ToolCall[]): ToolCallWire[] {
  return calls.map((c) => ({
    id: c.id,
    type: "function",
    function: { name: c.name, arguments: JSON.stringify(c.arguments) },
  }));
}

function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

function stringifyResult(result: unknown): string {
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
