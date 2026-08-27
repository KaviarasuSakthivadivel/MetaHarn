/** Thin client for @metaharn/server's HTTP + WebSocket API — see apps/server/src/index.ts. */

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
