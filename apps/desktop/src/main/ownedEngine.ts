/**
 * The owned-engine chat backend — a peer to createMetaHarnSession (agent.ts), selectable via
 * METAHARN_CHAT_ENGINE=owned instead of Pi. See docs/research/openworker-integration.md
 * ("Owning the Loop") and openworker-feature-catalog.md ("The Parts Bin") for the design.
 *
 * Deliberately NOT importing from "@metaharn/engine"'s barrel (src/index.ts): that re-exports
 * the whole package, and two of its modules pull in dependencies (@modelcontextprotocol/sdk,
 * better-sqlite3) whose own internals call require() on a Node builtin — fine normally, fatal
 * once Rollup bundles them into this forced-ESM main-process bundle with no real `require`
 * available (see vite.main.config.ts's external-list comment for the identical class of bug
 * with dotenv). Both are used here deliberately (MCP + memory), so both are marked `external`
 * in vite.main.config.ts instead of bundled — importing the specific submodules this file
 * needs, rather than the barrel, is what keeps every OTHER unused module (automation,
 * pdf-support) from being dragged in and needing the same treatment for no reason.
 *
 * Real, disclosed gaps in this pass: no session tree/branching, no context-window stats, no
 * Auto-Approve reviewer, no workspace-trust gate on the MCP config (global file only, no
 * per-project override), no memory-off Settings toggle (saving is always on).
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { app } from "electron";
import { Engine } from "@metaharn/engine/src/engine.js";
import { ToolRegistry } from "@metaharn/engine/src/tools/registry.js";
import { PermissionEngine } from "@metaharn/engine/src/permissions/engine.js";
import { ProviderRouter } from "@metaharn/engine/src/providers/router.js";
import type { ProviderClient } from "@metaharn/engine/src/providers/base.js";
import { AnthropicProvider } from "@metaharn/engine/src/providers/anthropic.js";
import { OpenAIProvider } from "@metaharn/engine/src/providers/openai.js";
import { createTodoWriteTool, TodoList } from "@metaharn/engine/src/tools/todo.js";
import { createGrepTool } from "@metaharn/engine/src/tools/search.js";
import { createGitLogTool } from "@metaharn/engine/src/tools/git.js";
import { createFileTools } from "@metaharn/engine/src/tools/files.js";
import { createRunShellTool } from "@metaharn/engine/src/tools/shell.js";
import { MCPManager } from "@metaharn/engine/src/mcp/client.js";
import { loadMcpServers } from "@metaharn/engine/src/mcp/config.js";
import { loadMcpTools } from "@metaharn/engine/src/mcp/tools.js";
import { SqliteMemoryStore } from "@metaharn/engine/src/memory/sqliteStore.js";
import { memoryTools } from "@metaharn/engine/src/memory/tools.js";
import { renderMemoryBlock } from "@metaharn/engine/src/memory/types.js";
import { Reviewer } from "@metaharn/engine/src/reviewer.js";
import { capture } from "@metaharn/engine/src/trust/sessionFacts.js";
import { AuditStore } from "@metaharn/engine/src/trust/auditStore.js";
import { createSchedulingTools } from "@metaharn/engine/src/automation/tools.js";
import type { TaskStore } from "@metaharn/engine/src/automation/store.js";
import type {
  ApprovalOutcome,
  ChatMessage,
  EngineEvent,
  PermissionRequest,
  Reviewer as ReviewerContract,
  ToolDefinition,
} from "@metaharn/engine/src/types.js";
import { buildContextDoc, whoOwns } from "@metaharn/context-engine";

/** Opt-in Auto-Approve mode: an LLM reviewer judges routine approval-required actions before
 * they reach the human, so only the genuinely questionable ones interrupt. Off by default —
 * matches this codebase's other experimental-toggle convention (METAHARN_CHAT_ENGINE). */
export function autoApproveEnabled(): boolean {
  return process.env.METAHARN_AUTO_APPROVE === "1";
}

/** Set once at app startup (main.ts, alongside automation.ts's startAutomationRuntime()) so
 * every owned-engine session can register scheduling tools against the ONE shared TaskStore.
 * A setter, not a direct import of automation.ts, specifically to avoid a circular import:
 * automation.ts's scheduled-task runner needs to construct sessions (imports THIS file), so
 * this file must not import automation.ts back. */
let schedulingStore: TaskStore | undefined;
export function setSchedulingStore(store: TaskStore): void {
  schedulingStore = store;
}

const MODEL_PROVIDER = process.env.METAHARN_MODEL_PROVIDER ?? "anthropic";
const MODEL_ID = process.env.METAHARN_MODEL_ID ?? "claude-opus-4-5";
const KNOWN_PROVIDERS = ["anthropic", "openai"];

/** Read-only, mirroring agent.ts's getModelConfig() for the Settings page. */
export function getOwnedEngineModelConfig() {
  return { provider: MODEL_PROVIDER, modelId: MODEL_ID };
}

// -- local state directory (this backend's own — Pi has its own, separate, convention) ------

function stateDir(): string {
  return app.getPath("userData");
}

function ownedSessionsDir(): string {
  const dir = join(stateDir(), "owned-sessions");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function mcpConfigPath(): string {
  return join(stateDir(), "mcp.json");
}

function memoryDbPath(): string {
  return join(stateDir(), "memory.db");
}

function sessionFilePath(id: string): string {
  return join(ownedSessionsDir(), `${id}.json`);
}

/** True iff `path` is one of THIS backend's own transcript files — the one signal ipc.ts
 * needs to route a resume to the right backend regardless of the CURRENT
 * METAHARN_CHAT_ENGINE value (an old owned-engine session must always resume as one, even if
 * the toggle later changes; same for an old Pi session resuming as Pi). */
export function isOwnedSessionPath(path: string): boolean {
  return dirname(path) === ownedSessionsDir();
}

interface OwnedSessionRecord {
  id: string;
  cwd: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
}

function loadOwnedSessionRecord(path: string): OwnedSessionRecord | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && "id" in parsed && "messages" in parsed) {
      return parsed as OwnedSessionRecord;
    }
    return null;
  } catch {
    return null;
  }
}

function firstUserText(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === "user");
  return first && typeof first.content === "string" ? first.content : "";
}

function deriveTitle(messages: ChatMessage[]): string {
  const text = firstUserText(messages).trim();
  if (!text) return "New chat";
  return text.length > 60 ? `${text.slice(0, 60)}...` : text;
}

/** Same shape sessions.ts's own SessionListItem expects, minus the `type`/`agentKind` fields
 * only that module knows how to attach — kept local rather than importing from preload.ts,
 * which runs contextBridge.exposeInMainWorld() at module scope and must never be imported
 * from main-process code. */
export interface OwnedSessionListItem {
  path: string;
  id: string;
  cwd: string;
  name: string;
  created: Date;
  modified: Date;
  messageCount: number;
  firstMessage: string;
}

/** Disk scan mirroring SessionManager.listAll()'s job, for this backend's own transcript
 * files — see sessions.ts's listAllSessions(), which merges this in alongside Pi's. */
export function listOwnedSessions(): OwnedSessionListItem[] {
  let files: string[];
  try {
    files = readdirSync(ownedSessionsDir()).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const items: OwnedSessionListItem[] = [];
  for (const file of files) {
    const record = loadOwnedSessionRecord(join(ownedSessionsDir(), file));
    if (!record) continue;
    items.push({
      path: join(ownedSessionsDir(), file),
      id: record.id,
      cwd: record.cwd,
      name: record.title,
      created: new Date(record.createdAt),
      modified: new Date(record.updatedAt),
      messageCount: record.messages.length,
      firstMessage: firstUserText(record.messages),
    });
  }
  return items;
}

export interface OwnedHistoryMessage {
  role: "user" | "assistant" | "tool";
  text: string;
}

/** ChatMessage[] -> the same flat {role, text} shape sessions.ts's messagesToHistory()
 * produces for Pi, so a resumed owned-engine session renders identically to a resumed Pi one. */
export function ownedMessagesToHistory(messages: ChatMessage[]): OwnedHistoryMessage[] {
  const history: OwnedHistoryMessage[] = [];
  for (const msg of messages) {
    if (typeof msg.content !== "string" || !msg.content) continue;
    if (msg.role === "user") history.push({ role: "user", text: msg.content });
    else if (msg.role === "assistant") history.push({ role: "assistant", text: msg.content });
    else if (msg.role === "tool") history.push({ role: "tool", text: msg.content });
  }
  return history;
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

const MEMORY_GUIDANCE = `You have persistent memory across sessions. Use \`remember\` for durable facts: the \
user's corrections and stated preferences (with the why), and project context you couldn't rederive from the \
code. Scope by what the fact is about — "global" for facts about the user, "workspace" for facts about this \
project. Save conservatively: check the known-memories list first and use \`memory_update\` instead of adding \
a near-duplicate.`;

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

export interface OwnedEngineSessionOptions {
  sessionId?: string;
  initialMessages?: ChatMessage[];
  createdAt?: string;
  title?: string;
  /** Rendered by sessionFacts.capture().render() at session-open time — only computed when
   * autoApproveEnabled() (session facts exist purely to feed the reviewer; no other consumer
   * in this pass). Passed in rather than captured inside the constructor because capture() is
   * async and a constructor can't be — see createOwnedEngineSession. */
  knownWorld?: string;
  /**
   * True for a scheduled-automation run (automation.ts) with no human watching: the approver
   * auto-denies anything not already covered by `taskRules` instead of parking a promise no
   * one will ever resolve — the alternative is an unattended run hanging forever the first
   * time it hits an approval-gated action outside its granted scope. A real Inbox (queue an
   * approval for a human to answer later, OpenWorker's HITL tier) is the eventual fix; this is
   * the honest fail-closed behavior until that exists.
   */
  unattended?: boolean;
  /** Target-bound standing grants from the owning ScheduledTask (automation/models.ts's
   * standingRules()) — auto-allows exactly the external-risk calls the user approved at
   * task-creation time, nothing broader. */
  taskRules?: Map<string, Set<string>>;
}

export class OwnedEngineSession {
  readonly sessionId: string;
  readonly cwd: string;
  private title: string;
  private readonly createdAt: string;
  private readonly engine: Engine;
  private readonly memoryStore: SqliteMemoryStore;
  private readonly mcpManager = new MCPManager();
  private readonly auditStore: AuditStore;
  private listener: ((event: OwnedSessionEvent) => void) | null = null;
  private readonly pendingApprovals = new Map<string, (outcome: ApprovalOutcome) => void>();
  private running = false;
  errorMessage: string | undefined;

  constructor(repoPath: string, opts: OwnedEngineSessionOptions = {}) {
    this.sessionId = opts.sessionId ?? randomUUID();
    this.cwd = repoPath;
    this.createdAt = opts.createdAt ?? new Date().toISOString();
    this.title = opts.title ?? deriveTitle(opts.initialMessages ?? []);

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

    this.memoryStore = new SqliteMemoryStore(memoryDbPath());
    registry.registerAll(memoryTools({ store: this.memoryStore, workspace: repoPath, savingEnabled: () => true }));
    const remembered = [
      ...this.memoryStore.list({ scope: "global" }),
      ...this.memoryStore.list({ scope: "workspace", workspace: repoPath }),
    ];
    const memoryBlock = renderMemoryBlock(remembered);

    // Scheduling tools (create/list/update/delete_scheduled_task) — only when
    // automation.ts's startAutomationRuntime() has run (main.ts, at app startup) and injected
    // the shared store via setSchedulingStore(). Every session shares the ONE store so a task
    // created from any chat is visible/editable from any other.
    if (schedulingStore) {
      registry.registerAll(
        createSchedulingTools(schedulingStore, {
          origin: { surface: "chat", sessionId: this.sessionId, agent: "owned" },
          defaultWorkspace: repoPath,
        }),
      );
    }

    this.auditStore = new AuditStore(join(stateDir(), "audit.db"));

    const permissions = new PermissionEngine({
      workspaceRoot: repoPath,
      mode: autoApproveEnabled() ? "auto-approve" : "interactive",
      // No MetaHarn-specific state files exist yet to protect here (unlike OpenWorker's
      // ~/.config/coworker/*.json — MetaHarn's own state lives in Postgres/.env, not local
      // JSON) — see permissions/engine.ts's own doc comment on this option. Revisit once
      // there's a real local settings file worth floor-protecting.
      protectedPaths: [],
      taskRules: opts.taskRules,
    });

    let instructions = `${BASE_INSTRUCTIONS}\n\n${buildContextDoc(repoPath)}`;
    if (memoryBlock) instructions += `\n\n${MEMORY_GUIDANCE}\n\n${memoryBlock}`;

    this.engine = new Engine({
      provider,
      registry,
      permissions,
      model: `${MODEL_PROVIDER}:${MODEL_ID}`,
      instructions,
      messages: opts.initialMessages,
      auditSink: (event) => this.auditStore.append({ ...event, sessionId: this.sessionId }),
      approver: opts.unattended
        ? async () => "deny"
        : (req: PermissionRequest) =>
            new Promise<ApprovalOutcome>((resolve) => {
              this.pendingApprovals.set(req.toolCallId, resolve);
            }),
      // Auto-Approve reviewer (METAHARN_AUTO_APPROVE=1): attached only when the mode above is
      // "auto-approve" — Engine consults it on every needsUser/non-human-only decision
      // regardless of mode, so an unattached reviewer (the common case) is how "auto-approve
      // behaves like interactive with no reviewer" actually holds, matching OpenWorker's own
      // "attached only when the flag is on" rule.
      reviewer: autoApproveEnabled()
        ? (new Reviewer({ provider, model: `${MODEL_PROVIDER}:${MODEL_ID}`, knownWorld: opts.knownWorld }) as ReviewerContract)
        : undefined,
    });

    // MCP: connects in the background, best-effort, never blocks session creation — a slow
    // or misconfigured server just means its tools appear a little late (or never), not that
    // opening a chat session hangs on it. Newly-registered tools are picked up on the very
    // next model call, since Engine reads registry.schemas() fresh every turn.
    void this.loadMcpToolsInBackground(registry);
  }

  private async loadMcpToolsInBackground(registry: ToolRegistry): Promise<void> {
    const servers = loadMcpServers({ global: mcpConfigPath() }).filter((s) => s.enabled);
    for (const server of servers) {
      try {
        registry.registerAll(await loadMcpTools(this.mcpManager, server));
      } catch (err) {
        console.warn(`[metaharn] MCP server "${server.name}" failed to connect:`, (err as Error).message);
      }
    }
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
      this.persist();
    }
  }

  private persist(): void {
    if (this.engine.messages.length === 0) return;
    if (this.title === "New chat") this.title = deriveTitle(this.engine.messages);
    const record: OwnedSessionRecord = {
      id: this.sessionId,
      cwd: this.cwd,
      title: this.title,
      createdAt: this.createdAt,
      updatedAt: new Date().toISOString(),
      messages: this.engine.messages,
    };
    try {
      writeFileSync(sessionFilePath(this.sessionId), JSON.stringify(record));
    } catch (err) {
      console.warn("[metaharn] failed to persist owned-engine session:", (err as Error).message);
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
    this.memoryStore.close();
    this.auditStore.close();
    void this.mcpManager.aclose();
  }

  get messages() {
    return this.engine.messages;
  }
}

export interface CreateOwnedEngineSessionOptions {
  resumeSessionPath?: string;
  /** Set by automation.ts for a scheduled-task run — see OwnedEngineSessionOptions. */
  unattended?: boolean;
  taskRules?: Map<string, Set<string>>;
}

/** Async because session facts (sessionFacts.capture(), for the reviewer's knownWorld) reads
 * git remotes off disk — only actually done when autoApproveEnabled(), so the common case
 * pays nothing for it. */
export async function createOwnedEngineSession(
  repoPath: string,
  options: CreateOwnedEngineSessionOptions = {},
): Promise<OwnedEngineSession> {
  const record = options.resumeSessionPath ? loadOwnedSessionRecord(options.resumeSessionPath) : null;
  const cwd = record?.cwd ?? repoPath;

  const knownWorld = autoApproveEnabled()
    ? (await capture({ roots: [{ path: cwd, writable: true }], workspace: cwd })).render()
    : undefined;

  return new OwnedEngineSession(cwd, {
    sessionId: record?.id,
    initialMessages: record?.messages,
    createdAt: record?.createdAt,
    title: record?.title,
    knownWorld,
    unattended: options.unattended,
    taskRules: options.taskRules,
  });
}

export function ownedEngineEnabled(): boolean {
  return process.env.METAHARN_CHAT_ENGINE === "owned";
}
