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
 * Real, disclosed gaps in this pass: no workspace-trust gate on the MCP config (global file
 * only, no per-project override), no memory-off Settings toggle (saving is always on).
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
import { createCompactionHook } from "@metaharn/engine/src/compaction.js";
import { capture } from "@metaharn/engine/src/trust/sessionFacts.js";
import { AuditStore } from "@metaharn/engine/src/trust/auditStore.js";
import { createSchedulingTools } from "@metaharn/engine/src/automation/tools.js";
import type { TaskStore } from "@metaharn/engine/src/automation/store.js";
import type {
  ApprovalOutcome,
  ChatMessage,
  EngineEvent,
  Reviewer as ReviewerContract,
  ToolDefinition,
} from "@metaharn/engine/src/types.js";
import { buildContextDoc, whoOwns } from "@metaharn/context-engine";
import { getAutoApproveSetting, getDefaultModel, PROVIDER_CATALOG, resolveProviderCredential } from "./ownedProviders.js";
import { isWorkspaceTrusted } from "./ownedWorkspaceTrust.js";
import { selfWakeToolsFor } from "./ownedSelfWake.js";
import { inboxApprover, inboxStore, toInboxResolution } from "./ownedInbox.js";

/** Opt-in Auto-Approve mode: an LLM reviewer judges routine approval-required actions before
 * they reach the human, so only the genuinely questionable ones interrupt. Off by default —
 * matches this codebase's other experimental-toggle convention (METAHARN_CHAT_ENGINE). */
export function autoApproveEnabled(): boolean {
  return getAutoApproveSetting() ?? process.env.METAHARN_AUTO_APPROVE === "1";
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

const KNOWN_PROVIDERS = PROVIDER_CATALOG.map((p) => p.name);

// Mirrors apps/server/src/session.ts's identical table — see that file's comment on why only
// these two providers get a real figure instead of createCompactionHook's 128k default.
const CONTEXT_WINDOW_BY_PROVIDER: Record<string, number> = {
  anthropic: 200_000,
  openai: 128_000,
};

/** Read-only, mirroring agent.ts's getModelConfig() for the Settings page. Reflects the
 * CURRENT default (Settings > Models can change it at runtime) — not a static snapshot. */
export function getOwnedEngineModelConfig() {
  return getDefaultModel();
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

/** Mirrors apps/server/src/session.ts's findSessionPath — used by automation.ts's self-wake
 * resume to turn a bare session id (all a Wake record has) back into a resumable path. */
export function findOwnedSessionPath(id: string): string | null {
  const path = sessionFilePath(id);
  return loadOwnedSessionRecord(path) ? path : null;
}

interface OwnedSessionRecord {
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
  /** Index into the PARENT's messages at branch time — see apps/server/src/session.ts's
   * identical field for the full rationale (getSessionTree() needs it to graft a branch onto
   * the exact node it split from). */
  branchPointIndex?: number;
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
  parentId?: string;
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
      parentId: record.parentId,
    });
  }
  return items;
}

export interface OwnedHistoryMessage {
  role: "user" | "assistant" | "tool";
  text: string;
  /** This message's position in the underlying ChatMessage[] — what "branch from here" needs
   * (getOwnedSessionTree()'s node ids are `${sessionId}:${index}` in this exact same array).
   * Not the same as this item's position in the returned array: the loop below skips the
   * seeded system message and any empty tool-call-only assistant message. */
  index: number;
}

/** ChatMessage[] -> the same flat {role, text} shape sessions.ts's messagesToHistory()
 * produces for Pi, so a resumed owned-engine session renders identically to a resumed Pi one. */
export function ownedMessagesToHistory(messages: ChatMessage[]): OwnedHistoryMessage[] {
  const history: OwnedHistoryMessage[] = [];
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
    if (!apiKey) throw new Error("Anthropic isn't set up yet — add a key in Settings.");
    return new AnthropicProvider(apiKey);
  }
  if (!entry.noKeyNeeded && !apiKey) throw new Error(`${entry.displayName} isn't set up yet — add a key in Settings.`);
  return new OpenAIProvider(apiKey ?? "ollama", { baseURL: baseUrl });
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
  | { type: "error"; message: string }
  /** A user or assistant message just landed at `index` in the underlying ChatMessage[] — what
   * the renderer needs to offer "branch from here" on a specific chat bubble live, without
   * waiting for a page reload's ownedMessagesToHistory() to supply it. */
  | { type: "message_index"; role: "user" | "assistant"; index: number };

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
  /** Carried forward from the OwnedSessionRecord on resume so a branched session doesn't lose
   * its lineage the next time it persists — see the class fields below. */
  parentId?: string;
  branchPointIndex?: number;
}

export class OwnedEngineSession {
  readonly sessionId: string;
  readonly cwd: string;
  private title: string;
  private readonly createdAt: string;
  // Set once at construction, never reassigned — persist() must keep re-writing these on every
  // save (they're not part of `messages`), or a branched session silently reverts to looking
  // like a root the moment it's resumed and sends one more turn. Mirrors the identical fix in
  // apps/server/src/session.ts.
  private readonly parentId?: string;
  private readonly branchPointIndex?: number;
  private readonly engine: Engine;
  private readonly memoryStore: SqliteMemoryStore;
  private readonly mcpManager = new MCPManager();
  private readonly auditStore: AuditStore;
  private listener: ((event: OwnedSessionEvent) => void) | null = null;
  private running = false;
  errorMessage: string | undefined;

  constructor(repoPath: string, opts: OwnedEngineSessionOptions = {}) {
    this.sessionId = opts.sessionId ?? randomUUID();
    this.cwd = repoPath;
    this.createdAt = opts.createdAt ?? new Date().toISOString();
    this.title = opts.title ?? deriveTitle(opts.initialMessages ?? []);
    this.parentId = opts.parentId;
    this.branchPointIndex = opts.branchPointIndex;

    const { provider: defaultProvider, modelId: defaultModelId } = getDefaultModel();
    const provider = new ProviderRouter({
      buildClient: buildProviderClient,
      defaultProvider,
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
    registry.registerAll(selfWakeToolsFor(this.sessionId));

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

    const model = `${defaultProvider}:${defaultModelId}`;

    this.engine = new Engine({
      provider,
      registry,
      permissions,
      model,
      instructions,
      messages: opts.initialMessages,
      compaction: createCompactionHook({ provider, model, contextWindow: CONTEXT_WINDOW_BY_PROVIDER[defaultProvider] }),
      auditSink: (event) => this.auditStore.append({ ...event, sessionId: this.sessionId }),
      // Interactive approvals go through the durable Inbox (ownedInbox.ts), not a bare
      // in-memory resolver — closing this session (or the whole app) with an approval still
      // outstanding no longer silently denies it; resumePending() picks the exact same wait
      // back up next time this session loads.
      approver: opts.unattended ? async () => "deny" as ApprovalOutcome : inboxApprover(inboxStore(), this.sessionId),
      // Auto-Approve reviewer (METAHARN_AUTO_APPROVE=1): attached only when the mode above is
      // "auto-approve" — Engine consults it on every needsUser/non-human-only decision
      // regardless of mode, so an unattached reviewer (the common case) is how "auto-approve
      // behaves like interactive with no reviewer" actually holds, matching OpenWorker's own
      // "attached only when the flag is on" rule.
      reviewer: autoApproveEnabled()
        ? (new Reviewer({ provider, model, knownWorld: opts.knownWorld }) as ReviewerContract)
        : undefined,
    });

    // MCP: connects in the background, best-effort, never blocks session creation — a slow
    // or misconfigured server just means its tools appear a little late (or never), not that
    // opening a chat session hangs on it. Newly-registered tools are picked up on the very
    // next model call, since Engine reads registry.schemas() fresh every turn.
    void this.loadMcpToolsInBackground(registry);
  }

  private async loadMcpToolsInBackground(registry: ToolRegistry): Promise<void> {
    const servers = loadMcpServers(
      { global: mcpConfigPath(), workspace: join(this.cwd, ".metaharn", "mcp.json") },
      { workspaceTrusted: isWorkspaceTrusted(this.cwd) },
    ).filter((s) => s.enabled);
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
    const item = inboxStore().forToolCall(this.sessionId, toolCallId);
    if (!item) return;
    inboxStore().resolve(item.id, toInboxResolution(outcome));
  }

  /** Picks back up any tool call still awaiting an answer from a PRIOR run of this session —
   * see apps/server/src/session.ts's identical resumePending() for the full rationale.
   * Engine.resume() is a safe no-op when there's nothing pending. */
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
   * the last message reproduces the old whole-session fork() behavior exactly (the owned-engine
   * equivalent of Pi's SessionManager.createBranchedSession()), and branching from an earlier
   * index is a genuine mid-conversation rewind-and-diverge, matching Pi's own tree branching.
   * Returns null when there's nothing to fork yet or the index is out of range, matching Pi's
   * own "nothing to fork yet" case (ipc.ts's forkChatSession handler already shows that alert
   * for a null result). */
  branchFrom(messageIndex: number): string | null {
    // Engine's constructor always seeds messages[0] with a system prompt derived from
    // `instructions` — messages.length is never actually 0 for a real session, so "nothing
    // to fork yet" has to mean "no real turn happened," i.e. no user message at all.
    if (!this.engine.messages.some((m) => m.role === "user")) return null;
    if (messageIndex < 0 || messageIndex >= this.engine.messages.length) return null;
    const newId = randomUUID();
    const record: OwnedSessionRecord = {
      id: newId,
      cwd: this.cwd,
      title: this.title,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: structuredClone(this.engine.messages.slice(0, messageIndex + 1)),
      parentId: this.sessionId,
      branchPointIndex: messageIndex,
    };
    const path = sessionFilePath(newId);
    writeFileSync(path, JSON.stringify(record));
    return path;
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
    const record: OwnedSessionRecord = {
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
      console.warn("[metaharn] failed to persist owned-engine session:", (err as Error).message);
    }
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
        // See apps/server/src/session.ts's identical fix for the full rationale: this event
        // means the engine is about to suspend on an Inbox wait that might outlive this
        // process, and this.messages already has everything resumePending() needs to pick it
        // back up — without persisting here, the Inbox row survives a crash but the
        // conversation it belongs to doesn't.
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
      // "usage": not forwarded as a live event — getSessionStats() (below) exposes the same
      // running total, polled by the renderer at the same points (ready/agent_end) Pi's own
      // stats already are, via the existing ContextWindowPanel. A second, redundant push
      // channel for the identical number isn't worth the extra event type.
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
    // Deliberately NOT auto-denying pending approvals here anymore — the whole point of the
    // durable Inbox (ownedInbox.ts) is that a pending row survives this session being torn
    // down; resumePending() picks it back up on next load instead.
    this.memoryStore.close();
    this.auditStore.close();
    void this.mcpManager.aclose();
  }

  get messages() {
    return this.engine.messages;
  }

  /** Same shape preload.ts's SessionStats expects (kept local rather than importing that
   * type — see OwnedSessionListItem's doc comment above on why main-process code must never
   * import from preload.ts). `cost` is always 0: unlike Pi, this engine doesn't have a
   * per-provider pricing table to compute it from, and 0 is honest where a guessed number
   * wouldn't be. `contextUsage` is left undefined for the same reason — `Engine.usage` is a
   * running total across the whole session, not the latest turn's context size, and those
   * answer different questions; ContextWindowPanel already renders a missing value as "—". */
  getSessionStats() {
    const messages = this.engine.messages;
    const usage = this.engine.usage;
    let userMessages = 0;
    let assistantMessages = 0;
    let toolCalls = 0;
    let toolResults = 0;
    for (const msg of messages) {
      if (msg.role === "user") userMessages++;
      else if (msg.role === "assistant") {
        assistantMessages++;
        toolCalls += msg.toolCalls?.length ?? 0;
      } else if (msg.role === "tool") toolResults++;
    }
    return {
      sessionFile: undefined,
      sessionId: this.sessionId,
      userMessages,
      assistantMessages,
      toolCalls,
      toolResults,
      totalMessages: messages.length,
      tokens: { ...usage, total: usage.input + usage.output + usage.cacheRead + usage.cacheWrite },
      cost: 0,
    };
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

  const session = new OwnedEngineSession(cwd, {
    sessionId: record?.id,
    initialMessages: record?.messages,
    createdAt: record?.createdAt,
    parentId: record?.parentId,
    branchPointIndex: record?.branchPointIndex,
    title: record?.title,
    knownWorld,
    unattended: options.unattended,
    taskRules: options.taskRules,
  });
  // Safe unconditionally — Engine.resume() no-ops when there's no dangling tool call to
  // pick back up (the common case: a brand-new session, or one that ended cleanly).
  session.resumePending();
  return session;
}

export function ownedEngineEnabled(): boolean {
  return process.env.METAHARN_CHAT_ENGINE === "owned";
}

/** Branches an ARBITRARY session by id — not necessarily the one currently loaded in the active
 * window — by reading its persisted record straight off disk. OwnedEngineSession.branchFrom()
 * is still what a live, currently-open session should use (its in-memory engine.messages can be
 * ahead of what was last persisted); this is for branching from an ancestor further back in the
 * tree that isn't the active session, e.g. picking an older node in the tree view. Mirrors
 * apps/server/src/session.ts's identical function. */
export function branchOwnedSessionAt(sessionId: string, messageIndex: number): string | null {
  const path = findOwnedSessionPath(sessionId);
  const record = path ? loadOwnedSessionRecord(path) : null;
  if (!record) return null;
  if (!record.messages.some((m) => m.role === "user")) return null;
  if (messageIndex < 0 || messageIndex >= record.messages.length) return null;
  const newId = randomUUID();
  const newRecord: OwnedSessionRecord = {
    id: newId,
    cwd: record.cwd,
    title: record.title,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: structuredClone(record.messages.slice(0, messageIndex + 1)),
    parentId: sessionId,
    branchPointIndex: messageIndex,
  };
  const newPath = sessionFilePath(newId);
  writeFileSync(newPath, JSON.stringify(newRecord));
  return newPath;
}

/** Same shape as apps/server/src/session.ts's SessionTreeNodeDTO, which itself matches Pi's own
 * sessions.ts's SessionTreeNodeDTO — one flat DTO shape lets SessionTreeView.tsx render a Pi
 * session's tree or an owned-engine session's tree with zero component changes. */
export interface OwnedSessionTreeNodeDTO {
  id: string;
  parentId: string | null;
  type: string;
  timestamp: string;
  label?: string;
  preview: string;
  children: OwnedSessionTreeNodeDTO[];
}

function previewForMessage(msg: ChatMessage): string {
  const text = typeof msg.content === "string" ? msg.content : "";
  return `${msg.role}: ${text.slice(0, 80)}`;
}

/** Reconstructs the full branch tree that `sessionId` belongs to. See apps/server/src/session.ts's
 * identical getSessionTree() for the full rationale — this is a line-for-line port, reading from
 * this backend's own ownedSessionsDir() instead. */
export function getOwnedSessionTree(sessionId: string): OwnedSessionTreeNodeDTO[] {
  const all = listOwnedSessions();
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

  const childrenByParent = new Map<string, OwnedSessionListItem[]>();
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
    const path = findOwnedSessionPath(sid);
    const record = path ? loadOwnedSessionRecord(path) : null;
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

  const flat = new Map<string, OwnedSessionTreeNodeDTO>();
  const visiting = new Set<string>();

  function walk(sid: string): void {
    if (visiting.has(sid)) return; // guards a corrupted/circular parentId chain
    visiting.add(sid);
    const path = findOwnedSessionPath(sid);
    const record = path ? loadOwnedSessionRecord(path) : null;
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

  const roots: OwnedSessionTreeNodeDTO[] = [];
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
