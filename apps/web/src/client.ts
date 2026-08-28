/** Thin client for @metaharn/server's HTTP + WebSocket API — see apps/server/src/index.ts. */

export type ApprovalOutcome = "once" | "always_tool" | "always_command" | "always_domain" | "readonly_session" | "deny";

/** `index` is this message's position in the underlying ChatMessage[] — what "branch from
 * here" needs (getSessionTree()'s node ids are `${sessionId}:${index}` in that same array). Not
 * the same as this item's position in the returned array: the server skips the seeded system
 * message and any empty tool-call-only assistant message, so array position and true message
 * index diverge after the first skip. */
export type HistoryMessage = { role: "user" | "assistant" | "tool"; text: string; index: number };

export type TodoStatus = "pending" | "in_progress" | "done";

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

export interface RootDir {
  path: string;
  writable: boolean;
  label: string;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type ServerEvent =
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  | { type: "permission_required"; toolCallId: string; toolName: string; args: unknown; reason: string }
  | { type: "agent_end" }
  | { type: "error"; message: string }
  | { type: "usage"; total: TokenUsage }
  /** A user or assistant message just landed at `index` in the underlying ChatMessage[] — what
   * the chat view needs to offer "branch from here" on a specific bubble live, without waiting
   * for a page reload's history to supply it. */
  | { type: "message_index"; role: "user" | "assistant"; index: number };

export interface SessionListItem {
  id: string;
  cwd: string;
  name: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
  parentId?: string;
}

export interface ProviderStatus {
  name: string;
  displayName: string;
  noKeyNeeded: boolean;
  configured: boolean;
  baseUrl?: string;
  /** Present only for providers with a dispatch-specific client (currently "gemini"/"bedrock") — see apps/server/src/providers.ts's ProviderCatalogEntry. */
  kind?: "gemini" | "bedrock";
  /** Whether enabling telemetry actually traces this provider — false only for "bedrock". */
  telemetryCovered: boolean;
}

export type MemoryScope = "global" | "workspace";

export interface MemoryItem {
  id: number;
  scope: MemoryScope;
  content: string;
  summary?: string;
  workspace?: string;
  createdAt?: string;
}

export interface McpServer {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args: string[];
  env: Record<string, string>;
  url?: string;
  headers: Record<string, string>;
  enabled: boolean;
}

export interface AutomationSchedule {
  kind: "cron" | "once";
  cron: string | null;
  fireAt: string | null;
  timezone: string;
}

export interface TaskRun {
  runId: string;
  startedAt: number;
  finishedAt: number | null;
  status: "running" | "ok" | "error" | "skipped";
  resultText: string | null;
  error: string | null;
  trigger: string;
}

export interface Automation {
  id: string;
  title: string;
  instructions: string;
  schedule: string;
  scheduleRaw: AutomationSchedule;
  workspace: string;
  enabled: boolean;
  nextRun: number | null;
  lastRun: number | null;
  lastStatus: string | null;
  runCount: number;
  recentRuns: TaskRun[];
}

interface RuntimeConfig {
  token: string;
  serverUrl: string;
  wsUrl: string;
}

// Fetched live from Vite's own dev-server middleware (vite.config.ts's tokenEndpoint plugin) on
// first use, with retries — never baked into the bundle at build time. See vite.config.ts's
// module doc for exactly why: a build-time constant races @metaharn/server's own startup under
// `dev:full`'s concurrent launch and can permanently strand the page with an empty token.
let configPromise: Promise<RuntimeConfig> | null = null;

async function getConfig(): Promise<RuntimeConfig> {
  if (!configPromise) {
    configPromise = (async () => {
      const maxAttempts = 15;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const res = await fetch("/__metaharn-config");
          const config = (await res.json()) as RuntimeConfig;
          if (config.token) return config;
        } catch {
          // dev server itself not up yet — retry
        }
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      throw new Error("Could not reach @metaharn/server — is it running? (npm run dev:server)");
    })();
  }
  return configPromise;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { token, serverUrl } = await getConfig();
  const res = await fetch(`${serverUrl}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", "X-MetaHarn-Token": token, ...init.headers },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(typeof body.error === "string" ? body.error : `request failed: ${res.status}`);
  return body as T;
}

export function health(): Promise<{ ok: boolean }> {
  return request("/v1/health");
}

export function appInfo(): Promise<{ provider: string; modelId: string }> {
  return request("/v1/appInfo");
}

export function listSessions(): Promise<{ sessions: SessionListItem[] }> {
  return request("/v1/sessions");
}

export function init(
  repoPath: string,
  resumeSessionId?: string,
): Promise<{ sessionId: string; history: HistoryMessage[]; usage: TokenUsage; todos: TodoItem[]; roots: RootDir[] }> {
  return request("/v1/init", { method: "POST", body: JSON.stringify({ repoPath, resumeSessionId }) });
}

export function prompt(sessionId: string, text: string): Promise<void> {
  return request(`/v1/sessions/${sessionId}/prompt`, { method: "POST", body: JSON.stringify({ text }) });
}

export function steer(sessionId: string, text: string): Promise<void> {
  return request(`/v1/sessions/${sessionId}/steer`, { method: "POST", body: JSON.stringify({ text }) });
}

export function abort(sessionId: string): Promise<void> {
  return request(`/v1/sessions/${sessionId}/abort`, { method: "POST" });
}

/** Duplicates the session's current history into a brand-new, independent session — a
 * whole-session fork, not a message-level branch point. Throws if there's nothing to fork
 * yet (no messages sent). */
export function forkSession(sessionId: string): Promise<{ sessionId: string }> {
  return request(`/v1/sessions/${sessionId}/fork`, { method: "POST" });
}

export interface SessionTreeNode {
  id: string;
  parentId: string | null;
  type: string;
  timestamp: string;
  label?: string;
  preview: string;
  children: SessionTreeNode[];
}

/** Reconstructs the full branch tree `sessionId` belongs to — every ancestor and every
 * descendant branch, not just this one session's own linear history. One node per message;
 * node ids are `${sessionId}:${messageIndex}`, which branchSession() below expects back
 * unchanged. See apps/server/src/session.ts's getSessionTree() for the reconstruction. */
export function getSessionTree(sessionId: string): Promise<{ nodes: SessionTreeNode[] }> {
  return request(`/v1/sessions/${sessionId}/tree`);
}

/** Branches off the message at `messageIndex` in the given node's session — the general form
 * of forkSession() (forking is branching from the last message). Always creates a NEW session
 * (a flat message array can't hold two branches at once); the caller switches to the returned
 * id the same way it would after forkSession(). */
export function branchSession(sessionId: string, messageIndex: number): Promise<{ sessionId: string }> {
  return request(`/v1/sessions/${sessionId}/branch`, { method: "POST", body: JSON.stringify({ messageIndex }) });
}

export function renameSession(sessionId: string, title: string): Promise<void> {
  return request(`/v1/sessions/${sessionId}/rename`, { method: "PUT", body: JSON.stringify({ title }) });
}

export function deleteSession(sessionId: string): Promise<void> {
  return request(`/v1/sessions/${sessionId}`, { method: "DELETE" });
}

export type FolderPickResult = { ok: true; path: string } | { ok: false; canceled?: boolean; error?: string };

/** Opens the REAL OS folder picker from the local server — works even in a plain browser tab,
 * since the server runs locally and can shell out to the platform's native dialog (osascript/
 * PowerShell/zenity). See apps/server/src/index.ts's pickNativeFolder() for the full story;
 * ported from OpenWorker's own sidecar-opened-dialog approach. */
export function pickFolderNative(): Promise<FolderPickResult> {
  return request("/v1/fs/pick", { method: "POST" });
}

export function resolvePermission(sessionId: string, toolCallId: string, outcome: ApprovalOutcome): Promise<void> {
  return request(`/v1/sessions/${sessionId}/resolvePermission`, { method: "POST", body: JSON.stringify({ toolCallId, outcome }) });
}

// -- The multi-folder Access panel: grant/revoke directories live, mid-session ------------

export function listRoots(sessionId: string): Promise<{ roots: RootDir[] }> {
  return request(`/v1/sessions/${sessionId}/roots`);
}

export function addRoot(sessionId: string, path: string, writable: boolean, label?: string): Promise<{ root: RootDir }> {
  return request(`/v1/sessions/${sessionId}/roots`, { method: "POST", body: JSON.stringify({ path, writable, label }) });
}

export function removeRoot(sessionId: string, path: string): Promise<{ ok: boolean }> {
  return request(`/v1/sessions/${sessionId}/roots`, { method: "DELETE", body: JSON.stringify({ path }) });
}

// -- Settings > Models ------------------------------------------------------------------

export function listProviders(): Promise<{ providers: ProviderStatus[] }> {
  return request("/v1/providers");
}

// A plain string-keyed bag, not a fixed {apiKey, baseUrl} pair — AWS Bedrock's form
// (region/authMethod/bedrockApiKey/awsProfile/awsAccessKeyId/awsSecretAccessKey/
// awsSessionToken) needs the rest of the fields to pass through untouched too.
export function setProvider(name: string, input: Record<string, string | undefined>): Promise<void> {
  return request(`/v1/providers/${name}`, { method: "PUT", body: JSON.stringify(input) });
}

export function deleteProviderKey(name: string): Promise<void> {
  return request(`/v1/providers/${name}`, { method: "DELETE" });
}

export function setDefaultModel(provider: string, modelId: string): Promise<void> {
  return request("/v1/settings/default-model", { method: "PUT", body: JSON.stringify({ provider, modelId }) });
}

export interface GeneralSettings {
  defaultModel: { provider: string; modelId: string };
  autoApprove: boolean;
  webSearchEnabled: boolean;
  telemetryEnabled: boolean;
  /** Whether a Laminar API key is resolvable (saved, or LMNR_PROJECT_API_KEY) — distinct from
   * telemetryEnabled: a key can be configured but tracing still switched off. */
  telemetryConfigured: boolean;
  telemetryEndpoint: { baseUrl: string; httpPort: number; grpcPort: number };
}

export function getSettings(): Promise<GeneralSettings> {
  return request("/v1/settings");
}

export function setAutoApprove(enabled: boolean): Promise<void> {
  return request("/v1/settings/auto-approve", { method: "PUT", body: JSON.stringify({ enabled }) });
}

export function setWebSearchEnabled(enabled: boolean): Promise<void> {
  return request("/v1/settings/web-search", { method: "PUT", body: JSON.stringify({ enabled }) });
}

/** Either field alone is a valid call — passing just `apiKey` saves it without changing the
 * toggle, passing just `enabled` flips the toggle using whatever key is already saved (or the
 * LMNR_PROJECT_API_KEY env var). The server applies this live, no restart needed. */
export function setTelemetry(input: { enabled?: boolean; apiKey?: string; baseUrl?: string; httpPort?: number; grpcPort?: number }): Promise<void> {
  return request("/v1/settings/telemetry", { method: "PUT", body: JSON.stringify(input) });
}

// -- Settings > Memory -------------------------------------------------------------------

export function listMemories(): Promise<{ memories: MemoryItem[] }> {
  return request("/v1/memory");
}

export function addMemory(content: string, scope: MemoryScope, workspace?: string): Promise<MemoryItem> {
  return request("/v1/memory", { method: "POST", body: JSON.stringify({ content, scope, workspace }) });
}

export function deleteMemory(id: number): Promise<void> {
  return request(`/v1/memory/${id}`, { method: "DELETE" });
}

// -- Workspace trust (gates a workspace's own .metaharn/mcp.json) ------------------------

export function getWorkspaceTrust(workspace: string): Promise<{ trusted: boolean }> {
  return request(`/v1/workspace-trust?workspace=${encodeURIComponent(workspace)}`);
}

export function setWorkspaceTrust(workspace: string, trusted: boolean): Promise<void> {
  return request("/v1/workspace-trust", { method: "PUT", body: JSON.stringify({ workspace, trusted }) });
}

// -- Inbox — durable approval queue, across every session, not just the open one --------

export interface InboxItem {
  id: string;
  kind: "approval" | "question";
  sessionId: string;
  toolCallId?: string;
  toolName?: string;
  arguments?: Record<string, unknown>;
  title?: string;
  body?: string;
  resolved: boolean;
  resolution?: string;
  createdAt: number;
  resolvedAt?: number;
}

export function listPendingInbox(): Promise<{ items: InboxItem[] }> {
  return request("/v1/inbox");
}

/** Resolves by item id alone — works even for a session that isn't the one currently open,
 * since the whole point of a durable Inbox is answering something without its session live. */
export function resolveInboxItem(itemId: string, outcome: ApprovalOutcome): Promise<void> {
  return request(`/v1/inbox/${itemId}/resolve`, { method: "POST", body: JSON.stringify({ outcome }) });
}

// -- Settings > MCP ----------------------------------------------------------------------

export function listMcpServers(): Promise<{ servers: McpServer[] }> {
  return request("/v1/mcp");
}

export function putMcpServer(name: string, input: Partial<McpServer>): Promise<void> {
  return request(`/v1/mcp/${name}`, { method: "PUT", body: JSON.stringify(input) });
}

export function deleteMcpServer(name: string): Promise<void> {
  return request(`/v1/mcp/${name}`, { method: "DELETE" });
}

export interface McpTestResult {
  ok: boolean;
  toolCount?: number;
  tools?: string[];
  error?: string;
}

export interface McpTestCandidate {
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

/** Live connectivity test — connects for real, lists tools, disconnects. Never just saves
 * a config and hopes; "Add & test" reports what actually happened. */
export function testMcpServer(candidate: McpTestCandidate): Promise<McpTestResult> {
  return request("/v1/mcp/test", { method: "POST", body: JSON.stringify(candidate) });
}

// -- Automations ---------------------------------------------------------------------------

export function listAutomations(): Promise<{ automations: Automation[] }> {
  return request("/v1/automations");
}

export function createAutomation(input: { title: string; instructions: string; workspace: string; schedule: AutomationSchedule }): Promise<Automation> {
  return request("/v1/automations", { method: "POST", body: JSON.stringify(input) });
}

export function setAutomationEnabled(id: string, enabled: boolean): Promise<Automation> {
  return request(`/v1/automations/${id}`, { method: "PUT", body: JSON.stringify({ enabled }) });
}

export function deleteAutomation(id: string): Promise<void> {
  return request(`/v1/automations/${id}`, { method: "DELETE" });
}

export function runAutomationNow(id: string): Promise<TaskRun> {
  return request(`/v1/automations/${id}/run`, { method: "POST" });
}

/** Opens the event stream for a session; returns an unsubscribe function. Async because it
 * needs the (possibly still-loading) runtime config first — callers don't await it directly
 * (App.tsx fires it and lets messages arrive whenever the socket actually opens), but the
 * returned unsubscribe is still available synchronously-ish via the promise chain. */
export async function subscribe(sessionId: string, onEvent: (event: ServerEvent) => void): Promise<() => void> {
  const { token, wsUrl } = await getConfig();
  const ws = new WebSocket(`${wsUrl}/v1/sessions/${sessionId}/events?token=${encodeURIComponent(token)}`);
  ws.addEventListener("message", (ev) => {
    try {
      onEvent(JSON.parse(ev.data as string) as ServerEvent);
    } catch {
      // malformed frame — drop it rather than crash the UI
    }
  });
  return () => ws.close();
}
