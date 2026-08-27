/**
 * The server's own session assembly — same @metaharn/engine wiring as apps/desktop's
 * ownedEngine.ts (providers, tools, memory, MCP, the reviewer, audit log, permissions,
 * transcript persistence), rebuilt here rather than imported from apps/desktop because
 * ownedEngine.ts hardcodes Electron's app.getPath("userData") for its state directory — this
 * process is plain Node, no Electron involved at all (that's the whole point of the OpenWorker
 * shape: the engine runs in one ordinary process, and a webview — Tauri's or a bare browser's
 * — never touches it directly).
 *
 * KNOWN DUPLICATION, not an oversight: this file and ownedEngine.ts will drift unless someone
 * consolidates the shared parts into @metaharn/engine itself (a host-agnostic session-assembly
 * helper parameterized by stateDir, with apps/desktop and apps/server both becoming thin
 * wrappers around it). Doing that refactor on the already-verified Electron path felt like the
 * wrong risk to take under this pass's time budget — see the Tauri section of
 * docs/research/openworker-integration.md for the flagged follow-up.
 *
 * Deliberately NOT included in this pass (disclosed gaps, matching ownedEngine.ts's own list
 * plus one more specific to this surface): automation/scheduling (no shared TaskStore exists
 * between this process and Electron's), the Postgres catalog (this server doesn't write to
 * @metaharn/db — sessions created here don't appear in Electron's sidebar; separate storage).
 */
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
import type { ApprovalOutcome, ChatMessage, EngineEvent, PermissionRequest, Reviewer as ReviewerContract, ToolDefinition } from "@metaharn/engine/src/types.js";
import { buildContextDoc, whoOwns } from "@metaharn/context-engine";

const MODEL_PROVIDER = process.env.METAHARN_MODEL_PROVIDER ?? "anthropic";
const MODEL_ID = process.env.METAHARN_MODEL_ID ?? "claude-opus-4-5";
const KNOWN_PROVIDERS = ["anthropic", "openai"];

export function autoApproveEnabled(): boolean {
  return process.env.METAHARN_AUTO_APPROVE === "1";
}

function stateDir(): string {
  const base =
    process.env.METAHARN_STATE_DIR ??
    (process.platform === "win32" ? join(process.env.APPDATA ?? homedir(), "MetaHarn") : join(homedir(), ".metaharn"));
  mkdirSync(base, { recursive: true });
  return base;
}

function sessionsDir(): string {
  const dir = join(stateDir(), "sessions");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function sessionFilePath(id: string): string {
  return join(sessionsDir(), `${id}.json`);
}

interface SessionRecord {
  id: string;
  cwd: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
}

function loadSessionRecord(path: string): SessionRecord | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && "id" in parsed && "messages" in parsed) return parsed as SessionRecord;
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

export interface SessionListItem {
  id: string;
  path: string;
  cwd: string;
  name: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
}

export function listSessions(): SessionListItem[] {
  let files: string[];
  try {
    files = readdirSync(sessionsDir()).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const items: SessionListItem[] = [];
  for (const file of files) {
    const record = loadSessionRecord(join(sessionsDir(), file));
    if (!record) continue;
    items.push({
      id: record.id,
      path: join(sessionsDir(), file),
      cwd: record.cwd,
      name: record.title,
      created: record.createdAt,
      modified: record.updatedAt,
      messageCount: record.messages.length,
      firstMessage: firstUserText(record.messages),
    });
  }
  return items.sort((a, b) => b.modified.localeCompare(a.modified));
}

export interface HistoryMessage {
  role: "user" | "assistant" | "tool";
  text: string;
}

export function messagesToHistory(messages: ChatMessage[]): HistoryMessage[] {
  const history: HistoryMessage[] = [];
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
    if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
    return new AnthropicProvider(key);
  }
  if (name === "openai") {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error("OPENAI_API_KEY is not set");
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
        description: "Look up the CODEOWNERS entry for a file or directory path in this repository.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Repo-relative path to look up." } },
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

export type SessionEvent =
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  | { type: "permission_required"; toolCallId: string; toolName: string; args: unknown; reason: string }
  | { type: "agent_end" }
  | { type: "error"; message: string };

export interface SessionOptions {
  sessionId?: string;
  initialMessages?: ChatMessage[];
  createdAt?: string;
  title?: string;
  /** Computed by createSession() before construction (sessionFacts.capture() is async; a
   * constructor can't be) — see ownedEngine.ts's identical pattern in apps/desktop. */
  knownWorld?: string;
}

export class ServerSession {
  readonly sessionId: string;
  readonly cwd: string;
  private title: string;
  private readonly createdAt: string;
  private readonly engine: Engine;
  private readonly memoryStore: SqliteMemoryStore;
  private readonly auditStore: AuditStore;
  private readonly mcpManager = new MCPManager();
  private listener: ((event: SessionEvent) => void) | null = null;
  private readonly pendingApprovals = new Map<string, (outcome: ApprovalOutcome) => void>();
  private running = false;
  errorMessage: string | undefined;

  constructor(repoPath: string, opts: SessionOptions = {}) {
    this.sessionId = opts.sessionId ?? randomUUID();
    this.cwd = repoPath;
    this.createdAt = opts.createdAt ?? new Date().toISOString();
    this.title = opts.title ?? deriveTitle(opts.initialMessages ?? []);

    const provider = new ProviderRouter({ buildClient: buildProviderClient, defaultProvider: MODEL_PROVIDER, knownProviders: KNOWN_PROVIDERS });

    const registry = new ToolRegistry();
    const todo = new TodoList();
    registry.register(createTodoWriteTool(todo));
    registry.register(createGrepTool(repoPath));
    registry.register(createGitLogTool(repoPath));
    registry.register(whoOwnsTool(repoPath));
    registry.registerAll(createFileTools(repoPath));
    registry.register(createRunShellTool(repoPath));

    this.memoryStore = new SqliteMemoryStore(join(stateDir(), "memory.db"));
    registry.registerAll(memoryTools({ store: this.memoryStore, workspace: repoPath, savingEnabled: () => true }));
    const remembered = [
      ...this.memoryStore.list({ scope: "global" }),
      ...this.memoryStore.list({ scope: "workspace", workspace: repoPath }),
    ];
    const memoryBlock = renderMemoryBlock(remembered);

    this.auditStore = new AuditStore(join(stateDir(), "audit.db"));

    const permissions = new PermissionEngine({
      workspaceRoot: repoPath,
      mode: autoApproveEnabled() ? "auto-approve" : "interactive",
      protectedPaths: [],
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
      approver: (req: PermissionRequest) =>
        new Promise<ApprovalOutcome>((resolve) => {
          this.pendingApprovals.set(req.toolCallId, resolve);
        }),
      reviewer: autoApproveEnabled()
        ? (new Reviewer({ provider, model: `${MODEL_PROVIDER}:${MODEL_ID}`, knownWorld: opts.knownWorld }) as ReviewerContract)
        : undefined,
    });

    void this.loadMcpToolsInBackground(registry);
  }

  private async loadMcpToolsInBackground(registry: ToolRegistry): Promise<void> {
    const servers = loadMcpServers({ global: join(stateDir(), "mcp.json") }).filter((s) => s.enabled);
    for (const server of servers) {
      try {
        registry.registerAll(await loadMcpTools(this.mcpManager, server));
      } catch (err) {
        console.warn(`[metaharn-server] MCP server "${server.name}" failed to connect:`, (err as Error).message);
      }
    }
  }

  subscribe(listener: (event: SessionEvent) => void): () => void {
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
    const record: SessionRecord = {
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
      console.warn("[metaharn-server] failed to persist session:", (err as Error).message);
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
        this.listener?.({ type: "tool_end", toolCallId: event.toolCallId, toolName: event.name, result: event.result, isError: !!event.error });
        break;
      case "permission_required":
        this.listener?.({ type: "permission_required", toolCallId: event.toolCallId, toolName: event.name, args: event.arguments, reason: event.reason });
        break;
      case "turn_end":
        this.listener?.({ type: "agent_end" });
        if (event.status === "error") this.errorMessage = this.errorMessage ?? "the turn ended with an error";
        break;
      case "error":
        this.errorMessage = event.error;
        this.listener?.({ type: "error", message: event.error });
        break;
    }
  }

  async prompt(text: string): Promise<void> {
    await this.drive(this.engine.run(text));
  }

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

export async function createSession(repoPath: string, resumeSessionPath?: string): Promise<ServerSession> {
  const record = resumeSessionPath ? loadSessionRecord(resumeSessionPath) : null;
  const cwd = record?.cwd ?? repoPath;
  const knownWorld = autoApproveEnabled()
    ? (await capture({ roots: [{ path: cwd, writable: true }], workspace: cwd })).render()
    : undefined;
  return new ServerSession(cwd, {
    sessionId: record?.id,
    initialMessages: record?.messages,
    createdAt: record?.createdAt,
    title: record?.title,
    knownWorld,
  });
}

export function findSessionPath(id: string): string | null {
  const path = sessionFilePath(id);
  return loadSessionRecord(path) ? path : null;
}

export function getModelConfig() {
  return { provider: MODEL_PROVIDER, modelId: MODEL_ID };
}
