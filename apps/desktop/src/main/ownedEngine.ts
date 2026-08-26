/**
 * The owned-engine chat backend — a peer to createMetaHarnSession (agent.ts), selectable via
 * METAHARN_CHAT_ENGINE=owned instead of Pi. See docs/research/openworker-integration.md
 * ("Owning the Loop") and openworker-feature-catalog.md ("The Parts Bin") for the design.
 *
 * Deliberately minimal: in-memory history only (no durable JSONL the way Pi's SessionManager
 * gives chat sessions — see 05-data-model.md), one tool set (read/write/edit/list/shell/grep/
 * git_log/todo/who_owns), interactive permission mode with no Auto-Approve reviewer wired.
 * Every one of those is a real, disclosed gap, not an oversight — the point of this pass is a
 * genuinely runnable second backend, not full parity with Pi on day one.
 */
import { randomUUID } from "node:crypto";
import {
  Engine,
  ToolRegistry,
  PermissionEngine,
  ProviderRouter,
  AnthropicProvider,
  OpenAIProvider,
  createTodoWriteTool,
  TodoList,
  createGrepTool,
  createGitLogTool,
  createFileTools,
  createRunShellTool,
  type ApprovalOutcome,
  type EngineEvent,
  type PermissionRequest,
  type ProviderClient,
  type ToolDefinition,
} from "@metaharn/engine";
import { buildContextDoc, whoOwns } from "@metaharn/context-engine";

const MODEL_PROVIDER = process.env.METAHARN_MODEL_PROVIDER ?? "anthropic";
const MODEL_ID = process.env.METAHARN_MODEL_ID ?? "claude-opus-4-5";
const KNOWN_PROVIDERS = ["anthropic", "openai"];

/** Read-only, mirroring agent.ts's getModelConfig() for the Settings page. */
export function getOwnedEngineModelConfig() {
  return { provider: MODEL_PROVIDER, modelId: MODEL_ID };
}

function buildProviderClient(name: string): ProviderClient {
  if (name === "anthropic") {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("ANTHROPIC_API_KEY is not set — required for the owned engine's anthropic provider");
    return new AnthropicProvider(key);
  }
  if (name === "openai") {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error("OPENAI_API_KEY is not set — required for the owned engine's openai provider");
    return new OpenAIProvider(key);
  }
  throw new Error(`unknown provider: ${name}`);
}

function whoOwnsTool(repoPath: string): ToolDefinition {
  return {
    name: "who_owns",
    schema: {
      type: "function",
      function: {
        name: "who_owns",
        description:
          "Look up the CODEOWNERS entry for a file or directory path in this repository. Use " +
          "this whenever you need to know who owns or is responsible for a piece of code.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Repo-relative path to look up, e.g. 'src/auth/login.ts'" },
          },
          required: ["path"],
        },
      },
    },
    metadata: { category: "context", riskLevel: "low", risk: "read", requiresApproval: false },
    execute: async (args) => {
      const path = String(args.path ?? "");
      const owners = whoOwns(repoPath, path);
      return owners ? { owners, text: `${path} is owned by: ${owners.join(", ")}` } : { owners: null, text: `No CODEOWNERS entry matches ${path}.` };
    },
  };
}

const BASE_INSTRUCTIONS = `You are MetaHarn's built-in coworker, working directly in the user's repository. You can \
read, search, write, and edit files, run shell commands, and check who owns a piece of code. Writes and shell \
commands ask for approval before running. Be direct and get to the point.`;

/** The flat event shape ipc.ts already speaks (see preload.ts's MetaHarnEvent), plus the one
 * genuinely new event type this backend introduces. Kept intentionally identical to Pi's
 * existing vocabulary wherever the same thing is being said, so the renderer's event handling
 * needs the smallest possible diff to support a second backend. */
export type OwnedSessionEvent =
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  | { type: "permission_required"; toolCallId: string; toolName: string; args: unknown; reason: string }
  | { type: "agent_end" }
  | { type: "error"; message: string };

export class OwnedEngineSession {
  readonly sessionId = randomUUID();
  private readonly engine: Engine;
  private listener: ((event: OwnedSessionEvent) => void) | null = null;
  private readonly pendingApprovals = new Map<string, (outcome: ApprovalOutcome) => void>();
  private running = false;
  errorMessage: string | undefined;

  constructor(repoPath: string) {
    const provider = new ProviderRouter({
      buildClient: buildProviderClient,
      defaultProvider: MODEL_PROVIDER,
      knownProviders: KNOWN_PROVIDERS,
    });

    const registry = new ToolRegistry();
    const todo = new TodoList();
    registry.register(createTodoWriteTool(todo));
    registry.register(createGrepTool(repoPath));
    registry.register(createGitLogTool(repoPath));
    registry.register(whoOwnsTool(repoPath));
    registry.registerAll(createFileTools(repoPath));
    registry.register(createRunShellTool(repoPath));

    const permissions = new PermissionEngine({
      workspaceRoot: repoPath,
      mode: "interactive",
      // No MetaHarn-specific state files exist yet to protect here (unlike OpenWorker's
      // ~/.config/coworker/*.json — MetaHarn's own state lives in Postgres/.env, not local
      // JSON) — see permissions/engine.ts's own doc comment on this option. Revisit once
      // there's a real local settings file worth floor-protecting.
      protectedPaths: [],
    });

    this.engine = new Engine({
      provider,
      registry,
      permissions,
      model: `${MODEL_PROVIDER}:${MODEL_ID}`,
      instructions: `${BASE_INSTRUCTIONS}\n\n${buildContextDoc(repoPath)}`,
      approver: (req: PermissionRequest) =>
        new Promise<ApprovalOutcome>((resolve) => {
          this.pendingApprovals.set(req.toolCallId, resolve);
        }),
    });
  }

  subscribe(listener: (event: OwnedSessionEvent) => void): () => void {
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = null;
    };
  }

  resolvePermission(toolCallId: string, outcome: ApprovalOutcome): void {
    const resolve = this.pendingApprovals.get(toolCallId);
    if (!resolve) return;
    this.pendingApprovals.delete(toolCallId);
    resolve(outcome);
  }

  private async drive(events: AsyncGenerator<EngineEvent>): Promise<void> {
    this.running = true;
    this.errorMessage = undefined;
    try {
      for await (const event of events) this.forward(event);
    } catch (err) {
      this.errorMessage = (err as Error).message;
      this.listener?.({ type: "error", message: this.errorMessage });
    } finally {
      this.running = false;
    }
  }

  private forward(event: EngineEvent): void {
    switch (event.type) {
      case "text_delta":
        this.listener?.({ type: "text_delta", delta: event.text });
        break;
      case "thinking_delta":
        this.listener?.({ type: "thinking_delta", delta: event.text });
        break;
      case "tool_start":
        this.listener?.({ type: "tool_start", toolCallId: event.toolCallId, toolName: event.name, args: event.arguments });
        break;
      case "tool_end":
        this.listener?.({
          type: "tool_end",
          toolCallId: event.toolCallId,
          toolName: event.name,
          result: event.result,
          isError: !!event.error,
        });
        break;
      case "permission_required":
        this.listener?.({
          type: "permission_required",
          toolCallId: event.toolCallId,
          toolName: event.name,
          args: event.arguments,
          reason: event.reason,
        });
        break;
      case "turn_end":
        this.listener?.({ type: "agent_end" });
        if (event.status === "error") this.errorMessage = this.errorMessage ?? "the turn ended with an error";
        break;
      case "error":
        this.errorMessage = event.error;
        this.listener?.({ type: "error", message: event.error });
        break;
      // turn_start / assistant_message: no Pi-vocabulary equivalent the renderer listens for
      // (the deltas already streamed the same content) — intentionally not forwarded.
    }
  }

  async prompt(text: string): Promise<void> {
    await this.drive(this.engine.run(text));
  }

  /** Steer and followUp collapse to the same behavior here: if a turn is already running,
   * queue the text for the engine's own steering point (checked once the model stops
   * requesting tools); otherwise there's nothing to steer, so just start a fresh turn. Pi
   * distinguishes "inject now" from "queue for after" — this engine's ported steering
   * mechanism (engine.ts, mirroring OpenWorker's queue_steering) only has the one semantic,
   * checked in one place, so this is a deliberate simplification, not a missed distinction. */
  async steer(text: string): Promise<void> {
    if (this.running) this.engine.queueSteering(text);
    else await this.prompt(text);
  }

  async followUp(text: string): Promise<void> {
    await this.steer(text);
  }

  abort(): void {
    this.engine.requestInterrupt();
  }

  dispose(): void {
    this.listener = null;
    for (const resolve of this.pendingApprovals.values()) resolve("deny");
    this.pendingApprovals.clear();
  }

  get messages() {
    return this.engine.messages;
  }
}

export function createOwnedEngineSession(repoPath: string): OwnedEngineSession {
  return new OwnedEngineSession(repoPath);
}

export function ownedEngineEnabled(): boolean {
  return process.env.METAHARN_CHAT_ENGINE === "owned";
}
