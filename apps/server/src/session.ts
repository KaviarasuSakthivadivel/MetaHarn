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
 * Automation (automationApi.ts) DOES run in this process, with its own TaskStore — separate
 * storage from Electron's, by the same "no shared store between processes" reasoning above.
 *
 * Deliberately NOT included in this pass: the Postgres catalog (this server doesn't write to
 * @metaharn/db — sessions created here don't appear in Electron's sidebar; separate storage).
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Engine } from "@metaharn/engine/src/engine.js";
import { ToolRegistry } from "@metaharn/engine/src/tools/registry.js";
import { PermissionEngine } from "@metaharn/engine/src/permissions/engine.js";
import { ProviderRouter } from "@metaharn/engine/src/providers/router.js";
import type { ProviderClient } from "@metaharn/engine/src/providers/base.js";
import { AnthropicProvider } from "@metaharn/engine/src/providers/anthropic.js";
import { OpenAIProvider } from "@metaharn/engine/src/providers/openai.js";
import { GeminiProvider } from "@metaharn/engine/src/providers/gemini.js";
import { BedrockProvider } from "@metaharn/engine/src/providers/bedrock.js";
import { createTodoWriteTool, TodoList, type TodoItem } from "@metaharn/engine/src/tools/todo.js";
import { createGrepTool } from "@metaharn/engine/src/tools/search.js";
import { createGitLogTool } from "@metaharn/engine/src/tools/git.js";
import { createFileTools } from "@metaharn/engine/src/tools/files.js";
import { createRunShellTool } from "@metaharn/engine/src/tools/shell.js";
import { createWebSearchTool } from "@metaharn/engine/src/tools/websearch.js";
import { makeRootDir, normalizeRoots, renderContext, type RootDir } from "@metaharn/engine/src/permissions/roots.js";
import { MCPManager } from "@metaharn/engine/src/mcp/client.js";
import { loadMcpServers } from "@metaharn/engine/src/mcp/config.js";
import { loadMcpTools } from "@metaharn/engine/src/mcp/tools.js";
import { SqliteMemoryStore } from "@metaharn/engine/src/memory/sqliteStore.js";
import { memoryTools } from "@metaharn/engine/src/memory/tools.js";
import { renderMemoryBlock } from "@metaharn/engine/src/memory/types.js";
import { Reviewer } from "@metaharn/engine/src/reviewer.js";
import { createCompactionHook } from "@metaharn/engine/src/compaction.js";
import { capture } from "@metaharn/engine/src/trust/sessionFacts.js";
import { AuditStore } from "@metaharn/engine/src/trust/auditStore.js";
import type { ApprovalOutcome, ChatMessage, EngineEvent, Reviewer as ReviewerContract, TokenUsage, ToolDefinition } from "@metaharn/engine/src/types.js";
import { buildContextDoc, whoOwns } from "@metaharn/context-engine";
import { stateDir } from "./state.js";
import { getAutoApprove, getDefaultModel, getWebSearchEnabled, PROVIDER_CATALOG, resolveBedrockCredential, resolveProviderCredential } from "./providers.js";
import { isWorkspaceTrusted } from "./workspaceTrustApi.js";
import { selfWakeToolsFor } from "./selfWakeApi.js";
import { inboxApprover, inboxStore, toInboxResolution } from "./inboxApi.js";

const KNOWN_PROVIDERS = PROVIDER_CATALOG.map((p) => p.name);

// Real, documented context windows for the providers this catalog actually knows well enough
// to state a number for; everything else falls back to createCompactionHook's own
// DEFAULT_CONTEXT_WINDOW (128k) rather than a guessed figure — compacting a bit earlier than
// strictly necessary is a minor cost, compacting too late risks a hard overflow error instead.
const CONTEXT_WINDOW_BY_PROVIDER: Record<string, number> = {
  anthropic: 200_000,
  openai: 128_000,
};

export function autoApproveEnabled(): boolean {
  return getAutoApprove() ?? process.env.METAHARN_AUTO_APPROVE === "1";
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
  /** Set only on a session created via branchFrom()/fork() — the session it was duplicated
   * from, so the sidebar can show "forked from <name>" instead of the lineage silently
   * disappearing. */
  parentId?: string;
  /** Index into the PARENT's messages at branch time — messages[0..branchPointIndex] are the
   * shared prefix (a verbatim copy), messages[branchPointIndex+1..] are this branch's own new
   * turns. Only meaningful alongside parentId; undefined for a root (unforked) session. Needed
   * by getSessionTree() to graft a branch onto the exact node it split from, instead of onto
   * the parent's tail. */
  branchPointIndex?: number;
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
  parentId?: string;
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
      parentId: record.parentId,
    });
  }
  return items.sort((a, b) => b.modified.localeCompare(a.modified));
}

export interface HistoryMessage {
  role: "user" | "assistant" | "tool";
  text: string;
  /** This message's position in the underlying ChatMessage[] — what "branch from here" needs
   * (getSessionTree()'s node ids are `${sessionId}:${index}` in this exact same array). Not the
   * same as this item's position in the returned HistoryMessage[]: the loop below skips the
   * seeded system message and any empty tool-call-only assistant message, so array position and
   * true message index diverge after the first skip. */
  index: number;
}

export function messagesToHistory(messages: ChatMessage[]): HistoryMessage[] {
  const history: HistoryMessage[] = [];
  messages.forEach((msg, index) => {
    if (typeof msg.content !== "string" || !msg.content) return;
    if (msg.role === "user") history.push({ role: "user", text: msg.content, index });
    else if (msg.role === "assistant") history.push({ role: "assistant", text: msg.content, index });
    else if (msg.role === "tool") history.push({ role: "tool", text: msg.content, index });
  });
  return history;
}

function buildProviderClient(name: string): ProviderClient {
  const entry = PROVIDER_CATALOG.find((p) => p.name === name);
  if (!entry) throw new Error(`unknown provider: ${name}`);
  const { apiKey, baseUrl } = resolveProviderCredential(name);
  if (name === "anthropic") {
    if (!apiKey) throw new Error("Anthropic isn't set up yet — add a key in Settings > Models.");
    return new AnthropicProvider(apiKey);
  }
  if (entry.kind === "gemini") {
    if (!apiKey) throw new Error("Gemini isn't set up yet — add a key in Settings > Models.");
    return new GeminiProvider({ apiKey });
  }
  if (entry.kind === "bedrock") {
    // No single "isn't set up" check the way a plain apiKey provider gets — Bedrock's three
    // auth methods (Bedrock API key, an AWS profile, or IAM keys) each have their own
    // completeness rule, and the "profile"/default-chain methods are legitimately usable with
    // every field blank (ambient ~/.aws credentials or an instance role) — see
    // BedrockProvider's own module doc for what each option maps to.
    const cred = resolveBedrockCredential();
    return new BedrockProvider({
      region: cred.region,
      apiKey: cred.authMethod === "api_key" ? cred.bedrockApiKey : undefined,
      profile: cred.authMethod === "profile" ? (cred.awsProfile ?? "") : undefined,
      accessKeyId: cred.authMethod === "iam" ? cred.awsAccessKeyId : undefined,
      secretAccessKey: cred.authMethod === "iam" ? cred.awsSecretAccessKey : undefined,
      sessionToken: cred.authMethod === "iam" ? cred.awsSessionToken : undefined,
    });
  }
  // Every other catalog entry (openai, ollama, and every OpenAI-compatible vendor added
  // alongside it) speaks the same Chat Completions wire shape — one client, routed by
  // baseURL, rather than a bespoke implementation per vendor. Ollama's endpoint ignores the
  // key but still expects the header present, hence the "ollama" fallback string.
  if (!entry.noKeyNeeded && !apiKey) throw new Error(`${entry.displayName} isn't set up yet — add a key in Settings > Models.`);
  return new OpenAIProvider(apiKey ?? "ollama", { baseURL: baseUrl });
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
  | { type: "error"; message: string }
  | { type: "usage"; total: TokenUsage }
  /** A user or assistant message just landed at `index` in the underlying ChatMessage[] — what
   * a client needs to offer "branch from here" on a specific chat bubble, live, without waiting
   * for a page reload's messagesToHistory() to supply it. See Engine's identical-purpose
   * EngineEvent fields this is forwarded from. */
  | { type: "message_index"; role: "user" | "assistant"; index: number };

export interface SessionOptions {
  sessionId?: string;
  initialMessages?: ChatMessage[];
  createdAt?: string;
  title?: string;
  /** Carried forward from the SessionRecord on resume so a branched session doesn't lose its
   * lineage the next time it persists — see ServerSession's own parentId/branchPointIndex
   * fields for why persist() needs these kept around rather than read once and discarded. */
  parentId?: string;
  branchPointIndex?: number;
  /** Computed by createSession() before construction (sessionFacts.capture() is async; a
   * constructor can't be) — see ownedEngine.ts's identical pattern in apps/desktop. */
  knownWorld?: string;
  /** Background/scheduled run: no human is present to answer an approval prompt, so anything
   * not pre-approved via `autoAllowTools`/`taskRules` is denied immediately instead of waiting
   * forever. */
  unattended?: boolean;
  /** Bare tool names auto-allowed without asking — how a ScheduledTask's own legacy, unscoped
   * standing grants (see automation/models.ts's nameAllowedTools) reach an unattended run's
   * PermissionEngine. */
  autoAllowTools?: string[];
  /** Tool -> allowed exact targets — a ScheduledTask's target-scoped standing grants (see
   * automation/models.ts's standingRules), checked by PermissionEngine regardless of mode.
   * Same mechanism apps/desktop's ownedEngine.ts uses for automation runs. */
  taskRules?: Map<string, Set<string>>;
}

export class ServerSession {
  readonly sessionId: string;
  readonly cwd: string;
  private title: string;
  private readonly createdAt: string;
  // Lineage, set once at construction and never reassigned — persist() must keep re-writing
  // these on every save (they're not in `messages`), or a branched session silently reverts to
  // looking like a root the moment it's resumed and sends one more turn. Found this exact bug
  // while building getSessionTree(): the original fork()/persist() pair only ever wrote
  // parentId on the INITIAL fork snapshot, never again afterward.
  private readonly parentId?: string;
  private readonly branchPointIndex?: number;
  private readonly engine: Engine;
  private readonly memoryStore: SqliteMemoryStore;
  private readonly auditStore: AuditStore;
  private readonly mcpManager = new MCPManager();
  // Public and mutable by design (see permissions/roots.ts's module doc) — the multi-folder
  // Access panel pushes/splices this directly, and PermissionEngine/the context provider below
  // both re-read it live on every check/turn, so a grant or revoke takes effect immediately
  // with no engine restart.
  private readonly permissions: PermissionEngine;
  private readonly todo = new TodoList();
  private listener: ((event: SessionEvent) => void) | null = null;
  private running = false;
  errorMessage: string | undefined;

  constructor(repoPath: string, opts: SessionOptions = {}) {
    this.sessionId = opts.sessionId ?? randomUUID();
    this.cwd = repoPath;
    this.createdAt = opts.createdAt ?? new Date().toISOString();
    this.title = opts.title ?? deriveTitle(opts.initialMessages ?? []);
    this.parentId = opts.parentId;
    this.branchPointIndex = opts.branchPointIndex;

    const { provider: defaultProvider, modelId: defaultModelId } = getDefaultModel();
    const provider = new ProviderRouter({ buildClient: buildProviderClient, defaultProvider, knownProviders: KNOWN_PROVIDERS });

    const registry = new ToolRegistry();
    registry.register(createTodoWriteTool(this.todo));
    registry.register(createGrepTool(repoPath));
    registry.register(createGitLogTool(repoPath));
    registry.register(whoOwnsTool(repoPath));
    registry.registerAll(createFileTools(repoPath));
    registry.register(createRunShellTool(repoPath));
    registry.registerAll(selfWakeToolsFor(this.sessionId));
    // Keyless by default (DuckDuckGo) — a session-level on/off switch, not a provider-key
    // gate like the model providers above. "Sources" in the multi-folder Access panel.
    if (getWebSearchEnabled()) registry.register(createWebSearchTool());

    this.memoryStore = new SqliteMemoryStore(join(stateDir(), "memory.db"));
    registry.registerAll(memoryTools({ store: this.memoryStore, workspace: repoPath, savingEnabled: () => true }));
    const remembered = [
      ...this.memoryStore.list({ scope: "global" }),
      ...this.memoryStore.list({ scope: "workspace", workspace: repoPath }),
    ];
    const memoryBlock = renderMemoryBlock(remembered);

    this.auditStore = new AuditStore(join(stateDir(), "audit.db"));

    // A second, private root every session gets for free — the default place to save a
    // deliverable that doesn't belong inside the workspace (a report, an analysis). Its own
    // directory per session (not shared) so one session's scratch files never leak into
    // another's "Artifacts" listing. mkdirSync here, not lazily on first write, since
    // PermissionEngine resolves/realpaths every root eagerly (resolveRealPath) and a
    // not-yet-created directory would resolve differently than after it exists.
    const scratchDir = join(stateDir(), "scratch", this.sessionId);
    mkdirSync(scratchDir, { recursive: true });

    this.permissions = new PermissionEngine({
      workspaceRoot: repoPath,
      mode: opts.unattended ? "custom" : autoApproveEnabled() ? "auto-approve" : "interactive",
      autoAllowTools: opts.unattended ? opts.autoAllowTools ?? [] : undefined,
      taskRules: opts.unattended ? opts.taskRules : undefined,
      protectedPaths: [],
      roots: [
        { path: repoPath, writable: true },
        { path: scratchDir, writable: true, label: "scratch" },
      ],
    });

    let instructions = `${BASE_INSTRUCTIONS}\n\n${buildContextDoc(repoPath)}`;
    if (memoryBlock) instructions += `\n\n${MEMORY_GUIDANCE}\n\n${memoryBlock}`;

    const model = `${defaultProvider}:${defaultModelId}`;

    this.engine = new Engine({
      provider,
      registry,
      permissions: this.permissions,
      model,
      instructions,
      messages: opts.initialMessages,
      // Live directory list on every turn — a grant/revoke through the Access panel takes
      // effect on the agent's very next message, no restart, since this re-reads
      // this.permissions.roots (mutable by reference) fresh each call rather than capturing
      // it once. Never persisted (Engine.outboundMessages() appends it ephemerally).
      contextProvider: () => renderContext(normalizeRoots(this.permissions.roots)),
      compaction: createCompactionHook({ provider, model, contextWindow: CONTEXT_WINDOW_BY_PROVIDER[defaultProvider] }),
      auditSink: (event) => this.auditStore.append({ ...event, sessionId: this.sessionId }),
      // Interactive approvals go through the durable Inbox (inboxApi.ts), not a bare
      // in-memory resolver — closing this process with an approval still outstanding no
      // longer silently denies it; the pending row survives, and the resumePending() call
      // below picks the exact same wait back up next time this session loads.
      approver: opts.unattended ? async () => "deny" as ApprovalOutcome : inboxApprover(inboxStore(), this.sessionId),
      reviewer:
        !opts.unattended && autoApproveEnabled()
          ? (new Reviewer({ provider, model, knownWorld: opts.knownWorld }) as ReviewerContract)
          : undefined,
    });

    void this.loadMcpToolsInBackground(registry);
  }

  private async loadMcpToolsInBackground(registry: ToolRegistry): Promise<void> {
    const servers = loadMcpServers(
      { global: join(stateDir(), "mcp.json"), workspace: join(this.cwd, ".metaharn", "mcp.json") },
      { workspaceTrusted: isWorkspaceTrusted(this.cwd) },
    ).filter((s) => s.enabled);
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
    const item = inboxStore().forToolCall(this.sessionId, toolCallId);
    if (!item) return;
    inboxStore().resolve(item.id, toInboxResolution(outcome));
  }

  /** Picks back up any tool call still awaiting an answer from a PRIOR run of this session
   * (a dangling approval, or self-wake resuming this exact session) — Engine.resume() is a
   * safe no-op when there's nothing pending, so this can run unconditionally on every load,
   * fresh or resumed. Fire-and-forget: an approval that's still genuinely pending will just
   * wait again on the same durable Inbox row (addApproval() dedupes on toolCallId), same as
   * it did before this session was last torn down. */
  resumePending(): void {
    void this.drive(this.engine.resume());
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

  /** Writes a NEW, independent session file containing a PREFIX of this session's current
   * messages (through and including messageIndex) — the general form of "fork": branching from
   * the last message reproduces the old whole-session fork() behavior exactly, and branching
   * from an earlier index is a genuine mid-conversation rewind-and-diverge, matching Pi's own
   * tree branching. Returns null when there's nothing to fork yet or the index is out of range. */
  branchFrom(messageIndex: number): string | null {
    // Engine's constructor always seeds messages[0] with a system prompt derived from
    // `instructions` — messages.length is never actually 0 for a real session, so "nothing
    // to fork yet" has to mean "no real turn happened," i.e. no user message at all.
    if (!this.engine.messages.some((m) => m.role === "user")) return null;
    if (messageIndex < 0 || messageIndex >= this.engine.messages.length) return null;
    const newId = randomUUID();
    const record: SessionRecord = {
      id: newId,
      cwd: this.cwd,
      title: this.title,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: structuredClone(this.engine.messages.slice(0, messageIndex + 1)),
      parentId: this.sessionId,
      branchPointIndex: messageIndex,
    };
    writeFileSync(sessionFilePath(newId), JSON.stringify(record));
    return newId;
  }

  /** Whole-session duplicate — branching from the last message. Kept as its own method since
   * "Fork" is a distinct, simpler user-facing action from picking a branch point in the tree
   * view, even though it's now just branchFrom's boundary case. */
  fork(): string | null {
    return this.branchFrom(this.engine.messages.length - 1);
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
      parentId: this.parentId,
      branchPointIndex: this.branchPointIndex,
    };
    try {
      writeFileSync(sessionFilePath(this.sessionId), JSON.stringify(record));
    } catch (err) {
      console.warn("[metaharn-server] failed to persist session:", (err as Error).message);
    }
  }

  /** User-driven rename (sidebar), distinct from persist()'s own auto-derived title — setting
   * this to anything other than the literal "New chat" also stops that auto-derivation from
   * overwriting it once the first real message lands. */
  rename(title: string): void {
    this.title = title;
    this.persist();
  }

  private forward(event: EngineEvent): void {
    switch (event.type) {
      case "user_message":
        this.listener?.({ type: "message_index", role: "user", index: event.index });
        break;
      case "assistant_message":
        this.listener?.({ type: "message_index", role: "assistant", index: event.index });
        break;
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
        // Persist NOW, not just when the turn completes: this event means the engine is
        // about to suspend on an Inbox wait that might outlive this process. this.messages
        // already includes the user message and the assistant's tool-call message at this
        // point (Engine pushes both before handleToolCalls ever runs) — everything
        // resumePending()'s unansweredTrailingToolCalls() needs to pick this back up after a
        // restart. Without this, the Inbox row survives a crash but the conversation it
        // belongs to doesn't (reproduced: killed the process mid-approval, restarted, and the
        // reloaded session had only its seed system message — the durable row pointed at
        // content that was never written).
        this.persist();
        break;
      case "turn_end":
        this.listener?.({ type: "agent_end" });
        if (event.status === "error") this.errorMessage = this.errorMessage ?? "the turn ended with an error";
        break;
      case "error":
        this.errorMessage = event.error;
        this.listener?.({ type: "error", message: event.error });
        break;
      case "usage":
        this.listener?.({ type: "usage", total: event.total });
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
    // Deliberately NOT auto-denying pending approvals here anymore — the whole point of the
    // durable Inbox (inboxApi.ts) is that a pending row survives this session being torn
    // down; resumePending() picks it back up on next load instead.
    this.memoryStore.close();
    this.auditStore.close();
    void this.mcpManager.aclose();
  }

  get messages() {
    return this.engine.messages;
  }

  get usage(): TokenUsage {
    return this.engine.usage;
  }

  /** The agent's own maintained plan (todo_write) — the "Progress" checklist. Not part of
   * `messages`; a live side-channel the tool replaces wholesale on every call. */
  get todos(): TodoItem[] {
    return this.todo.items;
  }

  /** Every folder this session can currently touch, normalized (absolute, symlink-resolved,
   * labeled) — what the multi-folder Access panel lists. Index 0 is always the primary
   * workspace, index 1 the private scratch dir; anything after that is a live grant. */
  get roots(): RootDir[] {
    return normalizeRoots(this.permissions.roots);
  }

  /** Grants a new folder for the rest of this session — pushes directly onto
   * PermissionEngine.roots (public and mutable by reference, see permissions/roots.ts), so
   * the very next tool call can use it; no engine restart. Returns the normalized RootDir
   * actually added (the resolved path may differ from the input, e.g. through a symlink). */
  addRoot(path: string, writable: boolean, label?: string): RootDir {
    const root = makeRootDir({ path, writable, label });
    this.permissions.roots.push(root);
    return root;
  }

  /** Revokes a previously-granted folder by its resolved path. Never removes index 0 (the
   * workspace) or index 1 (scratch) — those aren't "grants," they're the session's own roots;
   * the Access panel doesn't offer a revoke action on them for the same reason. Returns false
   * if no matching, revocable entry was found. */
  removeRoot(path: string): boolean {
    const resolved = makeRootDir({ path, writable: false }).path;
    const roots = this.permissions.roots;
    for (let i = 2; i < roots.length; i++) {
      if (makeRootDir(roots[i]).path === resolved) {
        roots.splice(i, 1);
        return true;
      }
    }
    return false;
  }
}

export interface CreateSessionOptions {
  unattended?: boolean;
  autoAllowTools?: string[];
  taskRules?: Map<string, Set<string>>;
}

export async function createSession(
  repoPath: string,
  resumeSessionPath?: string,
  opts: CreateSessionOptions = {},
): Promise<ServerSession> {
  const record = resumeSessionPath ? loadSessionRecord(resumeSessionPath) : null;
  const cwd = record?.cwd ?? repoPath;
  const knownWorld = autoApproveEnabled() || opts.unattended
    ? (await capture({ roots: [{ path: cwd, writable: true }], workspace: cwd })).render()
    : undefined;
  const session = new ServerSession(cwd, {
    sessionId: record?.id,
    initialMessages: record?.messages,
    createdAt: record?.createdAt,
    parentId: record?.parentId,
    branchPointIndex: record?.branchPointIndex,
    title: record?.title,
    knownWorld,
    unattended: opts.unattended,
    autoAllowTools: opts.autoAllowTools,
    taskRules: opts.taskRules,
  });
  // Safe unconditionally — Engine.resume() no-ops when there's no dangling tool call to
  // pick back up (the common case: a brand-new session, or one that ended cleanly).
  session.resumePending();
  return session;
}

export function findSessionPath(id: string): string | null {
  const path = sessionFilePath(id);
  return loadSessionRecord(path) ? path : null;
}

export function getModelConfig() {
  return getDefaultModel();
}

/** Branches an ARBITRARY session by id — not necessarily the one currently loaded in memory —
 * by reading its persisted record straight off disk. ServerSession.branchFrom() is still what
 * a live, currently-open session should use (its in-memory engine.messages can be ahead of what
 * was last persisted); this is for branching from an ancestor further back in the tree that
 * isn't the active session, e.g. picking an older node in the tree view. */
export function branchSessionAt(sessionId: string, messageIndex: number): string | null {
  const path = findSessionPath(sessionId);
  const record = path ? loadSessionRecord(path) : null;
  if (!record) return null;
  if (!record.messages.some((m) => m.role === "user")) return null;
  if (messageIndex < 0 || messageIndex >= record.messages.length) return null;
  const newId = randomUUID();
  const newRecord: SessionRecord = {
    id: newId,
    cwd: record.cwd,
    title: record.title,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: structuredClone(record.messages.slice(0, messageIndex + 1)),
    parentId: sessionId,
    branchPointIndex: messageIndex,
  };
  writeFileSync(sessionFilePath(newId), JSON.stringify(newRecord));
  return newId;
}

/** Renames an arbitrary session by id, straight off disk — same "not necessarily the live one"
 * reasoning as branchSessionAt(). A live in-memory ServerSession for this id (if any) is kept
 * in sync separately, by index.ts calling ServerSession.rename() alongside this. */
export function renameSessionRecord(sessionId: string, title: string): boolean {
  const path = findSessionPath(sessionId);
  const record = path ? loadSessionRecord(path) : null;
  if (!record) return false;
  record.title = title;
  record.updatedAt = new Date().toISOString();
  writeFileSync(sessionFilePath(sessionId), JSON.stringify(record));
  return true;
}

/** Deletes a session's persisted record and its private scratch directory. Does NOT touch any
 * live in-memory ServerSession — index.ts's DELETE handler disposes that (if present) before
 * calling this, so a session mid-turn isn't torn down from under itself. */
export function deleteSessionRecord(sessionId: string): boolean {
  const path = findSessionPath(sessionId);
  if (!path) return false;
  unlinkSync(path);
  rmSync(join(stateDir(), "scratch", sessionId), { recursive: true, force: true });
  return true;
}

/** Same shape as apps/desktop's Pi-backed SessionTreeNodeDTO (sessions.ts's treeToDTO) so the
 * one renderer tree component works for both backends unmodified. Pi's tree nodes are one per
 * SDK session-entry (message, compaction, model change, ...); this owned-engine tree is one
 * node per ChatMessage, which is the finest granularity a flat message array actually has. */
export interface SessionTreeNodeDTO {
  id: string;
  parentId: string | null;
  type: string;
  timestamp: string;
  label?: string;
  preview: string;
  children: SessionTreeNodeDTO[];
}

function previewForMessage(msg: ChatMessage): string {
  const text = typeof msg.content === "string" ? msg.content : "";
  return `${msg.role}: ${text.slice(0, 80)}`;
}

/** Reconstructs the full branch tree that `sessionId` belongs to. The owned engine has no
 * built-in tree structure (each branch is its own flat, independent session file linked only by
 * parentId/branchPointIndex) — this walks up to the lineage's root, then back down through every
 * descendant, grafting each branch's own NEW messages (branchPointIndex+1 onward — the shared
 * prefix is a literal copy, not shown twice) onto the exact node it split from. Node ids are
 * `${sessionId}:${messageIndex}`, which is also how ipc.ts's branchSession handler recovers which
 * session+index the user picked, without changing SessionTreeNodeDTO's shape at all. */
export function getSessionTree(sessionId: string): SessionTreeNodeDTO[] {
  const all = listSessions();
  const byId = new Map(all.map((s) => [s.id, s]));
  if (!byId.has(sessionId)) return [];

  let rootId = sessionId;
  const climbed = new Set<string>();
  while (true) {
    const rec = byId.get(rootId);
    if (!rec?.parentId || climbed.has(rootId) || !byId.has(rec.parentId)) break;
    climbed.add(rootId);
    rootId = rec.parentId;
  }

  const childrenByParent = new Map<string, SessionListItem[]>();
  for (const s of all) {
    if (!s.parentId) continue;
    const bucket = childrenByParent.get(s.parentId);
    if (bucket) bucket.push(s);
    else childrenByParent.set(s.parentId, [s]);
  }

  // The index a session's OWN new content starts at — 0 for a root, branchPointIndex+1 for a
  // branch. NOT the same as "the index to start walking from when grafting a grandchild": a
  // grandchild can branch from an index that's still part of ITS PARENT's inherited (copied)
  // prefix, not the parent's own unique range — e.g. branch B off A at index 2, then branch C
  // off B at index 3 (B's own only unique index), then branch D off C at index 3 too (still
  // shared with B, since C's own unique range only starts at 4). D's true parent node is B:3,
  // not C:3 — C:3 was never built as a node because C's own loop only ever built C:4 onward.
  // resolveNodeId() below walks the parent chain until it finds whichever session actually
  // OWNS a given index, instead of assuming the direct parent always does.
  const fromIndexCache = new Map<string, number>();
  function ownFromIndex(sid: string): number {
    const cached = fromIndexCache.get(sid);
    if (cached !== undefined) return cached;
    const path = findSessionPath(sid);
    const record = path ? loadSessionRecord(path) : null;
    const value = record?.branchPointIndex !== undefined ? record.branchPointIndex + 1 : 0;
    fromIndexCache.set(sid, value);
    return value;
  }

  function resolveNodeId(sid: string, index: number, guard = new Set<string>()): string {
    if (guard.has(sid)) return `${sid}:${index}`; // circular parentId — bail rather than loop
    if (index >= ownFromIndex(sid)) return `${sid}:${index}`;
    const parentId = byId.get(sid)?.parentId;
    if (!parentId) return `${sid}:${index}`;
    guard.add(sid);
    return resolveNodeId(parentId, index, guard);
  }

  const flat = new Map<string, SessionTreeNodeDTO>();
  const visiting = new Set<string>();

  function walk(sid: string): void {
    if (visiting.has(sid)) return; // guards a corrupted/circular parentId chain
    visiting.add(sid);
    const path = findSessionPath(sid);
    const record = path ? loadSessionRecord(path) : null;
    if (record) {
      const fromIndex = ownFromIndex(sid);
      let prevNodeId = fromIndex > 0 ? resolveNodeId(sid, fromIndex - 1) : null;
      for (let i = fromIndex; i < record.messages.length; i++) {
        const nodeId = `${sid}:${i}`;
        flat.set(nodeId, {
          id: nodeId,
          parentId: prevNodeId,
          type: record.messages[i].role,
          timestamp: record.updatedAt,
          preview: previewForMessage(record.messages[i]),
          children: [],
        });
        prevNodeId = nodeId;
      }
      for (const child of childrenByParent.get(sid) ?? []) walk(child.id);
    }
    visiting.delete(sid);
  }

  walk(rootId);

  const roots: SessionTreeNodeDTO[] = [];
  for (const node of flat.values()) {
    if (node.parentId === null) {
      roots.push(node);
      continue;
    }
    const parent = flat.get(node.parentId);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}
