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
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import {
  createSession,
  findSessionPath,
  getModelConfig,
  listSessions,
  messagesToHistory,
  type ServerSession,
  type SessionEvent,
} from "./session.js";
import type { ApprovalOutcome } from "@metaharn/engine/src/types.js";

const PORT = Number(process.env.METAHARN_SERVER_PORT ?? 8765);
const TOKEN = randomBytes(24).toString("hex");

function stateDirForToken(): string {
  const base =
    process.env.METAHARN_STATE_DIR ??
    (process.platform === "win32" ? join(process.env.APPDATA ?? "", "MetaHarn") : join(process.env.HOME ?? ".", ".metaharn"));
  mkdirSync(base, { recursive: true });
  return base;
}

// Per-launch token file, 0600-equivalent via default umask on the state dir — a standalone
// dev UI reads this to authenticate, matching OpenWorker's own <state-dir>/sidecar-<port>.token
// convention exactly. A packaged Tauri build would instead hold this in memory and pass it to
// its own webview directly, never touching disk (also matching OpenWorker) — not built in this
// pass since there's no packaged Tauri build yet to receive it that way.
const tokenPath = join(stateDirForToken(), `server-${PORT}.token`);
writeFileSync(tokenPath, TOKEN, { mode: 0o600 });
console.log(`[metaharn-server] token written to ${tokenPath}`);

const sessions = new Map<string, ServerSession>();

function checkToken(headerToken: string | undefined, queryToken: string | undefined): boolean {
  return headerToken === TOKEN || queryToken === TOKEN;
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
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
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

    if (url.pathname === "/v1/sessions" && req.method === "GET") {
      json(res, 200, { sessions: listSessions() });
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

server.listen(PORT, () => {
  console.log(`[metaharn-server] listening on http://localhost:${PORT}`);
});

function shutdown(): void {
  console.log("[metaharn-server] shutting down");
  for (const session of sessions.values()) session.dispose();
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
