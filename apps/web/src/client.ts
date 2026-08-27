/** Thin client for @metaharn/server's HTTP + WebSocket API — see apps/server/src/index.ts. */

const BASE = __METAHARN_SERVER_URL__;
const WS_BASE = __METAHARN_WS_URL__;
const TOKEN = __METAHARN_TOKEN__;

export type ApprovalOutcome = "once" | "always_tool" | "always_command" | "always_domain" | "readonly_session" | "deny";

export type HistoryMessage = { role: "user" | "assistant" | "tool"; text: string };

export type ServerEvent =
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  | { type: "permission_required"; toolCallId: string; toolName: string; args: unknown; reason: string }
  | { type: "agent_end" }
  | { type: "error"; message: string };

export interface SessionListItem {
  id: string;
  cwd: string;
  name: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", "X-MetaHarn-Token": TOKEN, ...init.headers },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(typeof body.error === "string" ? body.error : `request failed: ${res.status}`);
  return body as T;
}

export function hasToken(): boolean {
  return TOKEN.length > 0;
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

export function init(repoPath: string, resumeSessionId?: string): Promise<{ sessionId: string; history: HistoryMessage[] }> {
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

export function resolvePermission(sessionId: string, toolCallId: string, outcome: ApprovalOutcome): Promise<void> {
  return request(`/v1/sessions/${sessionId}/resolvePermission`, { method: "POST", body: JSON.stringify({ toolCallId, outcome }) });
}

/** Opens the event stream for a session; returns an unsubscribe function. */
export function subscribe(sessionId: string, onEvent: (event: ServerEvent) => void): () => void {
  const ws = new WebSocket(`${WS_BASE}/v1/sessions/${sessionId}/events?token=${encodeURIComponent(TOKEN)}`);
  ws.addEventListener("message", (ev) => {
    try {
      onEvent(JSON.parse(ev.data as string) as ServerEvent);
    } catch {
      // malformed frame — drop it rather than crash the UI
    }
  });
  return () => ws.close();
}
