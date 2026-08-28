/**
 * The local agent server — MetaHarn's OpenWorker-shaped backend for the web/Tauri surface.
 * One Node process, one HTTP server (REST for commands, WebSocket for streaming events),
 * exactly OpenWorker's own shape (coworker/server/{app,run}.py): a UI never runs the engine
 * itself, it only ever talks to this process.
 *
 * Auth mirrors OpenWorker's X-OpenWorker-Token convention: a random per-launch token, written
 * to a token file the dev UI reads (see apps/web's dev proxy), required on every request via
 * an `X-MetaHarn-Token` header or a `token` query param (the query param exists only because
 * browser WebSocket clients can't set custom headers on the handshake — same reason
 * OpenWorker accepts it there too).
 */
import "dotenv/config";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { WebSocketServer } from "ws";
import { statePath } from "./state.js";
import {
  autoApproveEnabled,
  branchSessionAt,
  createSession,
  deleteSessionRecord,
  findSessionPath,
  getModelConfig,
  getSessionTree,
  listSessions,
  messagesToHistory,
  renameSessionRecord,
  type ServerSession,
  type SessionEvent,
} from "./session.js";
import type { ApprovalOutcome } from "@metaharn/engine/src/types.js";
import type { Scope } from "@metaharn/engine/src/memory/types.js";
import type { Schedule } from "@metaharn/engine/src/automation/models.js";
import { deleteProvider, getWebSearchEnabled, listProviders, setAutoApprove, setDefaultModel, setProvider, setWebSearchEnabled } from "./providers.js";
import { isWorkspaceTrusted, setWorkspaceTrust } from "./workspaceTrustApi.js";
import { listPendingInbox, resolveInboxItem } from "./inboxApi.js";
import { addMemory, deleteMemory, listMemories, updateMemory } from "./memoryApi.js";
import { deleteMcpServer, listMcpServers, putMcpServer, testMcpServer, type McpServerInput } from "./mcpApi.js";
import {
  createAutomation,
  deleteAutomation,
  listAutomations,
  runAutomationNow,
  startAutomationScheduler,
  stopAutomationScheduler,
  updateAutomation,
} from "./automationApi.js";

// Deliberately NOT 8765 (OpenWorker's own default) — a real OpenWorker install and this
// server are both plausible to have running on the same machine at once (the whole point of
// this surface is to mirror OpenWorker's shape closely enough to compare directly), and two
// servers defaulting to the identical port is a real, reproduced collision: whichever binds
// second gets EADDRINUSE, or worse, a client silently talks to the WRONG server and gets back
// its unrelated (very similarly worded) auth-error shape. 8791 has no known collision.
const PORT = Number(process.env.METAHARN_SERVER_PORT ?? 8791);
const TOKEN = randomBytes(24).toString("hex");

// Per-launch token file, 0600-equivalent via default umask on the state dir — a standalone
// dev UI reads this to authenticate, matching OpenWorker's own <state-dir>/sidecar-<port>.token
// convention exactly. A packaged Tauri build would instead hold this in memory and pass it to
// its own webview directly, never touching disk (also matching OpenWorker) — not built in this
// pass since there's no packaged Tauri build yet to receive it that way.
const tokenPath = statePath(`server-${PORT}.token`);
writeFileSync(tokenPath, TOKEN, { mode: 0o600 });
console.log(`[metaharn-server] token written to ${tokenPath}`);

const sessions = new Map<string, ServerSession>();

function checkToken(headerToken: string | undefined, queryToken: string | undefined): boolean {
  return headerToken === TOKEN || queryToken === TOKEN;
}

const execFileAsync = promisify(execFile);

/** Opens the REAL OS folder picker from the server process, for POST /v1/fs/pick — ported
 * from OpenWorker's own `coworker/server/manager.py`'s `pick_native_folder()`. A plain browser
 * tab can't get a real absolute path out of a web file dialog (the File System Access API only
 * hands back a sandboxed handle), but this server runs locally on the same machine the browser
 * does, so it can shell out to the platform's native picker and hand back the real path — the
 * same trick OpenWorker's own sidecar uses, not a custom in-app dialog standing in for one.
 * Blocks (up to 5 minutes) until the user picks or cancels; the route awaits it directly since
 * only one folder pick happens at a time. */
async function pickNativeFolder(): Promise<{ ok: true; path: string } | { ok: false; canceled?: boolean; error?: string }> {
  let cmd: string;
  let args: string[];
  if (process.platform === "darwin") {
    cmd = "osascript";
    args = [
      "-e",
      'tell application "System Events" to activate',
      "-e",
      'POSIX path of (choose folder with prompt "Give MetaHarn access to a folder")',
    ];
  } else if (process.platform === "win32") {
    // WinForms folder dialog via PowerShell — no extra deps. -STA is required (the dialog
    // silently fails in the default MTA apartment).
    const ps =
      "Add-Type -AssemblyName System.Windows.Forms; " +
      "$f = New-Object System.Windows.Forms.FolderBrowserDialog; " +
      "$f.Description = 'Give MetaHarn access to a folder'; " +
      "if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($f.SelectedPath) }";
    cmd = "powershell.exe";
    args = ["-NoProfile", "-STA", "-Command", ps];
  } else {
    // Linux: zenity when present; otherwise the caller falls back to manual path entry.
    cmd = "zenity";
    args = ["--file-selection", "--directory"];
  }
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: 300_000, windowsHide: true });
    const path = stdout.trim();
    return path ? { ok: true, path } : { ok: false, canceled: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ok: false, error: "no native folder picker available" };
    // A non-zero exit here is the OS dialog's own cancel signal (osascript/zenity both exit
    // non-zero on Cancel; the PowerShell script writes nothing to stdout on Cancel), not a
    // real failure — same reasoning as the Python reference this was ported from.
    return { ok: false, canceled: true };
  }
}

function json(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(text);
}

async function readBody(req: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    // CORS preflight — the dev UI runs on Vite's own port, a different origin.
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type,X-MetaHarn-Token",
      });
      res.end();
      return;
    }

    if (url.pathname === "/v1/health") {
      json(res, 200, { ok: true });
      return;
    }

    const headerToken = req.headers["x-metaharn-token"];
    if (!checkToken(typeof headerToken === "string" ? headerToken : undefined, url.searchParams.get("token") ?? undefined)) {
      json(res, 401, { error: "unauthorized" });
      return;
    }

    if (url.pathname === "/v1/appInfo" && req.method === "GET") {
      json(res, 200, getModelConfig());
      return;
    }

    if (url.pathname === "/v1/fs/pick" && req.method === "POST") {
      const result = await pickNativeFolder();
      json(res, 200, result);
      return;
    }

    if (url.pathname === "/v1/sessions" && req.method === "GET") {
      json(res, 200, { sessions: listSessions() });
      return;
    }

    // -- Settings > Models --------------------------------------------------------------

    if (url.pathname === "/v1/providers" && req.method === "GET") {
      json(res, 200, { providers: listProviders() });
      return;
    }

    const providerMatch = url.pathname.match(/^\/v1\/providers\/([^/]+)$/);
    if (providerMatch && req.method === "PUT") {
      const body = await readBody(req);
      try {
        // A plain string-keyed bag, not a fixed {apiKey, baseUrl} pair — most providers only
        // ever send those two, but AWS Bedrock's form (region/authMethod/bedrockApiKey/
        // awsProfile/accessKeyId/secretAccessKey/sessionToken) needs the rest of the fields
        // to pass through untouched too.
        const fields: Record<string, string | undefined> = {};
        for (const [key, value] of Object.entries(body)) if (typeof value === "string") fields[key] = value;
        setProvider(providerMatch[1], fields);
        json(res, 200, { ok: true });
      } catch (err) {
        json(res, 400, { error: (err as Error).message });
      }
      return;
    }
    if (providerMatch && req.method === "DELETE") {
      deleteProvider(providerMatch[1]);
      json(res, 200, { ok: true });
      return;
    }

    if (url.pathname === "/v1/settings/default-model" && req.method === "PUT") {
      const body = await readBody(req);
      setDefaultModel(String(body.provider ?? ""), String(body.modelId ?? ""));
      json(res, 200, { ok: true });
      return;
    }


    if (url.pathname === "/v1/settings" && req.method === "GET") {
      json(res, 200, { defaultModel: getModelConfig(), autoApprove: autoApproveEnabled(), webSearchEnabled: getWebSearchEnabled() });
      return;
    }
    if (url.pathname === "/v1/settings/auto-approve" && req.method === "PUT") {
      const body = await readBody(req);
      setAutoApprove(Boolean(body.enabled));
      json(res, 200, { ok: true });
      return;
    }
    if (url.pathname === "/v1/settings/web-search" && req.method === "PUT") {
      const body = await readBody(req);
      setWebSearchEnabled(Boolean(body.enabled));
      json(res, 200, { ok: true });
      return;
    }

    // -- Settings > Memory ----------------------------------------------------------------

    if (url.pathname === "/v1/memory" && req.method === "GET") {
      const scope = url.searchParams.get("scope") as Scope | null;
      const workspace = url.searchParams.get("workspace") ?? undefined;
      json(res, 200, { memories: listMemories({ scope: scope ?? undefined, workspace }) });
      return;
    }
    if (url.pathname === "/v1/memory" && req.method === "POST") {
      const body = await readBody(req);
      const content = String(body.content ?? "").trim();
      if (!content) {
        json(res, 400, { error: "content is required" });
        return;
      }
      const item = addMemory(content, {
        scope: (body.scope as Scope | undefined) ?? "workspace",
        workspace: typeof body.workspace === "string" ? body.workspace : undefined,
        summary: typeof body.summary === "string" ? body.summary : undefined,
      });
      json(res, 200, item);
      return;
    }
    const memoryMatch = url.pathname.match(/^\/v1\/memory\/(\d+)$/);
    if (memoryMatch && req.method === "PUT") {
      const body = await readBody(req);
      const item = updateMemory(Number(memoryMatch[1]), String(body.content ?? ""), typeof body.summary === "string" ? body.summary : undefined);
      if (!item) {
        json(res, 404, { error: "no such memory" });
        return;
      }
      json(res, 200, item);
      return;
    }
    if (memoryMatch && req.method === "DELETE") {
      json(res, 200, { ok: deleteMemory(Number(memoryMatch[1])) });
      return;
    }

    // -- Settings > MCP ---------------------------------------------------------------------

    if (url.pathname === "/v1/workspace-trust" && req.method === "GET") {
      const workspace = url.searchParams.get("workspace") ?? "";
      json(res, 200, { trusted: workspace ? isWorkspaceTrusted(workspace) : false });
      return;
    }
    if (url.pathname === "/v1/workspace-trust" && req.method === "PUT") {
      const body = await readBody(req);
      const workspace = String(body.workspace ?? "");
      if (!workspace) {
        json(res, 400, { error: "workspace is required" });
        return;
      }
      setWorkspaceTrust(workspace, Boolean(body.trusted));
      json(res, 200, { ok: true });
      return;
    }

    // -- Inbox --------------------------------------------------------------------------------

    if (url.pathname === "/v1/inbox" && req.method === "GET") {
      json(res, 200, { items: listPendingInbox() });
      return;
    }
    const inboxResolveMatch = url.pathname.match(/^\/v1\/inbox\/([^/]+)\/resolve$/);
    if (inboxResolveMatch && req.method === "POST") {
      const body = await readBody(req);
      const outcome = String(body.outcome ?? "deny") as ApprovalOutcome;
      const ok = resolveInboxItem(inboxResolveMatch[1], outcome);
      if (!ok) {
        json(res, 404, { error: "no such pending item" });
        return;
      }
      json(res, 200, { ok: true });
      return;
    }

    if (url.pathname === "/v1/mcp" && req.method === "GET") {
      json(res, 200, { servers: listMcpServers() });
      return;
    }
    if (url.pathname === "/v1/mcp/test" && req.method === "POST") {
      const body = await readBody(req);
      const result = await testMcpServer({
        transport: body.url ? "http" : "stdio",
        command: typeof body.command === "string" ? body.command : undefined,
        args: Array.isArray(body.args) ? (body.args as string[]) : [],
        env: (body.env as Record<string, string> | undefined) ?? {},
        url: typeof body.url === "string" ? body.url : undefined,
        headers: (body.headers as Record<string, string> | undefined) ?? {},
      });
      json(res, 200, result);
      return;
    }
    const mcpMatch = url.pathname.match(/^\/v1\/mcp\/([^/]+)$/);
    if (mcpMatch && req.method === "PUT") {
      const body = await readBody(req);
      putMcpServer(mcpMatch[1], body as McpServerInput);
      json(res, 200, { ok: true });
      return;
    }
    if (mcpMatch && req.method === "DELETE") {
      json(res, 200, { ok: deleteMcpServer(mcpMatch[1]) });
      return;
    }

    // -- Automations --------------------------------------------------------------------

    if (url.pathname === "/v1/automations" && req.method === "GET") {
      json(res, 200, { automations: listAutomations() });
      return;
    }
    if (url.pathname === "/v1/automations" && req.method === "POST") {
      const body = await readBody(req);
      try {
        const automation = createAutomation({
          title: String(body.title ?? "Untitled automation"),
          instructions: String(body.instructions ?? ""),
          workspace: String(body.workspace ?? ""),
          schedule: body.schedule as Partial<Schedule> & Pick<Schedule, "kind">,
        });
        json(res, 200, automation);
      } catch (err) {
        json(res, 400, { error: (err as Error).message });
      }
      return;
    }
    const automationMatch = url.pathname.match(/^\/v1\/automations\/([^/]+)$/);
    if (automationMatch && req.method === "PUT") {
      const body = await readBody(req);
      const automation = updateAutomation(automationMatch[1], {
        title: typeof body.title === "string" ? body.title : undefined,
        instructions: typeof body.instructions === "string" ? body.instructions : undefined,
        enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
        schedule: body.schedule as (Partial<Schedule> & Pick<Schedule, "kind">) | undefined,
      });
      if (!automation) {
        json(res, 404, { error: "no such automation" });
        return;
      }
      json(res, 200, automation);
      return;
    }
    if (automationMatch && req.method === "DELETE") {
      json(res, 200, { ok: deleteAutomation(automationMatch[1]) });
      return;
    }
    const automationRunMatch = url.pathname.match(/^\/v1\/automations\/([^/]+)\/run$/);
    if (automationRunMatch && req.method === "POST") {
      const run = await runAutomationNow(automationRunMatch[1]);
      if (!run) {
        json(res, 404, { error: "no such automation" });
        return;
      }
      json(res, 200, run);
      return;
    }

    if (url.pathname === "/v1/init" && req.method === "POST") {
      const body = await readBody(req);
      const repoPath = String(body.repoPath ?? "");
      const resumeSessionId = typeof body.resumeSessionId === "string" ? body.resumeSessionId : undefined;
      if (!repoPath) {
        json(res, 400, { error: "repoPath is required" });
        return;
      }
      try {
        const resumePath = resumeSessionId ? findSessionPath(resumeSessionId) : null;
        const session = await createSession(repoPath, resumePath ?? undefined);
        sessions.set(session.sessionId, session);
        json(res, 200, {
          sessionId: session.sessionId,
          history: resumePath ? messagesToHistory(session.messages) : [],
          usage: session.usage,
          todos: session.todos,
          roots: session.roots,
        });
      } catch (err) {
        json(res, 500, { error: (err as Error).message });
      }
      return;
    }

    const turnMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/(prompt|steer|followUp|abort)$/);
    if (turnMatch && req.method === "POST") {
      const [, sessionId, action] = turnMatch;
      const session = sessions.get(sessionId);
      if (!session) {
        json(res, 404, { error: "no such session" });
        return;
      }
      if (action === "abort") {
        session.abort();
        json(res, 200, { ok: true });
        return;
      }
      const body = await readBody(req);
      const text = String(body.text ?? "");
      // Fire-and-forget: the turn's events stream over the WebSocket, not this response —
      // matches Electron's ipc.ts's own prompt/steer/followUp handlers (a resolved promise
      // just means "the turn finished," never carries the turn's content itself).
      void session[action as "prompt" | "steer" | "followUp"](text);
      json(res, 202, { ok: true });
      return;
    }

    const forkMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/fork$/);
    if (forkMatch && req.method === "POST") {
      const session = sessions.get(forkMatch[1]);
      if (!session) {
        json(res, 404, { error: "no such session" });
        return;
      }
      const newId = session.fork();
      if (!newId) {
        json(res, 400, { error: "nothing to fork yet — send a message first" });
        return;
      }
      json(res, 200, { sessionId: newId });
      return;
    }

    const renameMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/rename$/);
    if (renameMatch && req.method === "PUT") {
      const body = await readBody(req);
      const title = String(body.title ?? "").trim();
      if (!title) {
        json(res, 400, { error: "title is required" });
        return;
      }
      // A live in-memory session (the one currently open in a browser tab) can be ahead of
      // what's on disk — rename it directly so its own next persist() doesn't clobber this;
      // otherwise fall back to the on-disk record, same "not necessarily the live one"
      // reasoning as branch/tree.
      const live = sessions.get(renameMatch[1]);
      if (live) live.rename(title);
      const ok = live ? true : renameSessionRecord(renameMatch[1], title);
      if (!ok) {
        json(res, 404, { error: "no such session" });
        return;
      }
      json(res, 200, { ok: true });
      return;
    }

    const sessionIdMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)$/);
    if (sessionIdMatch && req.method === "DELETE") {
      const id = sessionIdMatch[1];
      const live = sessions.get(id);
      if (live) {
        live.dispose();
        sessions.delete(id);
      }
      const ok = deleteSessionRecord(id);
      if (!ok) {
        json(res, 404, { error: "no such session" });
        return;
      }
      json(res, 200, { ok: true });
      return;
    }

    const treeMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/tree$/);
    if (treeMatch && req.method === "GET") {
      json(res, 200, { nodes: getSessionTree(treeMatch[1]) });
      return;
    }

    const branchMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/branch$/);
    if (branchMatch && req.method === "POST") {
      const targetId = branchMatch[1];
      const body = await readBody(req);
      const messageIndex = Number(body.messageIndex);
      if (!Number.isInteger(messageIndex)) {
        json(res, 400, { error: "messageIndex must be an integer" });
        return;
      }
      // The target session might not be the one currently loaded (branching from an ancestor
      // node in the tree view) — prefer the live in-memory session when it IS active (its
      // messages can be ahead of what's on disk), fall back to a disk read otherwise.
      const active = sessions.get(targetId);
      const newId = active ? active.branchFrom(messageIndex) : branchSessionAt(targetId, messageIndex);
      if (!newId) {
        json(res, 400, { error: "nothing to branch from at that index" });
        return;
      }
      json(res, 200, { sessionId: newId });
      return;
    }

    const permMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/resolvePermission$/);
    if (permMatch && req.method === "POST") {
      const session = sessions.get(permMatch[1]);
      if (!session) {
        json(res, 404, { error: "no such session" });
        return;
      }
      const body = await readBody(req);
      session.resolvePermission(String(body.toolCallId ?? ""), String(body.outcome ?? "deny") as ApprovalOutcome);
      json(res, 200, { ok: true });
      return;
    }

    // -- The multi-folder Access panel: grant/revoke directories live, mid-session ---------

    const rootsMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/roots$/);
    if (rootsMatch && req.method === "GET") {
      const session = sessions.get(rootsMatch[1]);
      if (!session) {
        json(res, 404, { error: "no such session" });
        return;
      }
      json(res, 200, { roots: session.roots });
      return;
    }
    if (rootsMatch && req.method === "POST") {
      const session = sessions.get(rootsMatch[1]);
      if (!session) {
        json(res, 404, { error: "no such session" });
        return;
      }
      const body = await readBody(req);
      const path = String(body.path ?? "");
      if (!path) {
        json(res, 400, { error: "path is required" });
        return;
      }
      try {
        const root = session.addRoot(path, Boolean(body.writable), typeof body.label === "string" ? body.label : undefined);
        json(res, 200, { root });
      } catch (err) {
        json(res, 400, { error: (err as Error).message });
      }
      return;
    }
    if (rootsMatch && req.method === "DELETE") {
      const session = sessions.get(rootsMatch[1]);
      if (!session) {
        json(res, 404, { error: "no such session" });
        return;
      }
      const body = await readBody(req);
      const ok = session.removeRoot(String(body.path ?? ""));
      json(res, ok ? 200 : 404, { ok });
      return;
    }

    json(res, 404, { error: "not found" });
  })().catch((err) => {
    console.error("[metaharn-server] request handler error:", err);
    json(res, 500, { error: "internal error" });
  });
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const match = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/events$/);
  const session = match ? sessions.get(match[1]) : undefined;
  if (!match || !session || !checkToken(undefined, url.searchParams.get("token") ?? undefined)) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const unsubscribe = session.subscribe((event: SessionEvent) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
    });
    ws.on("close", unsubscribe);
  });
});

// `tsx watch` restarts this whole process on every source change: the OLD process's socket
// isn't always fully released by the OS before the NEW one tries to bind the same port,
// especially under a burst of rapid saves — an unhandled 'error' event on a net.Server
// crashes the process outright (reproduced: a few-hundred-ms EADDRINUSE window during a fast
// edit/restart cycle). Retrying a handful of times with a short backoff rides out that
// window instead of taking the whole dev server down over a timing race that resolves itself.
const LISTEN_RETRY_MS = 300;
const LISTEN_MAX_RETRIES = 10;
let listenAttempts = 0;

function tryListen(): void {
  server.listen(PORT, () => {
    console.log(`[metaharn-server] listening on http://localhost:${PORT}`);
    startAutomationScheduler();
  });
}

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE" && listenAttempts < LISTEN_MAX_RETRIES) {
    listenAttempts++;
    console.warn(`[metaharn-server] port ${PORT} still in use, retrying (${listenAttempts}/${LISTEN_MAX_RETRIES})...`);
    setTimeout(tryListen, LISTEN_RETRY_MS);
    return;
  }
  console.error(`[metaharn-server] failed to listen on port ${PORT}:`, err.message);
  process.exit(1);
});

tryListen();

function shutdown(): void {
  console.log("[metaharn-server] shutting down");
  void stopAutomationScheduler();
  for (const session of sessions.values()) session.dispose();
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
